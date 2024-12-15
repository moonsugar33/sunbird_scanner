import gspread
import asyncio
import aiohttp
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
import pandas as pd
import logging
from typing import List, Tuple, Optional, Dict, Any
from datetime import datetime
import os

# Create logs directory if it doesn't exist
os.makedirs('logs', exist_ok=True)

# Configure logging to both file and console
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(f'logs/google_sheets_{datetime.now().strftime("%Y%m%d_%H%M%S")}.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

SHEET_CONFIGS = {
    'sheet1': {
        'url': 'https://docs.google.com/spreadsheets/d/1YGgkXoyam7tnbXb-vqWsHFs3Puyf_xYeXY2dPrZQY1M',
        'sheet_name': 'GazaVetters',
        'url_column': 'C',
        'id_column': 'A',
        'start_row': 6
    },
    'sheet2': {
        'url': 'https://docs.google.com/spreadsheets/d/1fzUVFMTcmcqd1_5xst2pJr73h4LUk_tg_9P_H4CXR00',
        'sheet_name': 'supabase data',
        'url_column': 'D',
        'id_column': 'A',
        'start_row': 1
    }
}

HEADERS: Dict[str, str] = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive',
}

async def fetch_url(session, url) -> str:
    if not url or not isinstance(url, str):
        logger.warning(f"Invalid URL provided: {url}")
        return url
        
    try:
        async with session.get(url, allow_redirects=True, timeout=30, headers=HEADERS) as response:
            if response.status != 200:
                logger.warning(f"Non-200 status code ({response.status}) for URL: {url}")
            final_url = str(response.url)
            logger.debug(f"Successfully fetched URL: {final_url}")
            return final_url
    except asyncio.TimeoutError:
        logger.error(f"Timeout while fetching URL: {url}")
        return url
    except Exception as e:
        logger.error(f"Error fetching URL {url}: {str(e)}")
        return url

def strip_tracking_params(url: str) -> str:
    if not url or not isinstance(url, str):
        return url
    
    try:
        parsed = urlparse(url)
        # Parse query parameters
        query_dict = parse_qs(parsed.query, keep_blank_values=True)
        
        # Expanded list of tracking parameters to remove
        tracking_params = {
            # UTM parameters
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            # Social media
            'fbclid', 'gclid', '_ga', 'ref', 'source', 'campaign', 'medium',
            # Referral parameters
            'ref_src', 'ref_url', 'ref_map', 'ref_type', 'ref_id', 'ref_content',
            # Additional tracking
            '_hsenc', '_hsmi', 'mc_cid', 'mc_eid', 'ml_subscriber', 'ml_subscriber_hash',
            # Twitter/X parameters
            's', 't', 'twclid',
            # Other common parameters
            'share', 'action', 'feature', 'tracking', 'tracked', 'debug',
            'dm_i', 'eh', 'sa', 'ved', 'ei', 'url', 'src', 'source_id', 'sourceid',
            '_ke', 'hsCtaTracking', 'hash', '_branch_match_id'
        }
        
        # Remove tracking parameters
        filtered_query = {
            k: v for k, v in query_dict.items()
            if k.lower() not in tracking_params
        }
        
        # Rebuild the URL
        new_query = urlencode(filtered_query, doseq=True)
        clean_url = urlunparse((
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            new_query,
            parsed.fragment
        ))
        
        # Remove trailing slashes for consistency
        return clean_url.rstrip('/')
    except Exception as e:
        logger.error(f"Error parsing URL {url}: {str(e)}")
        return url

async def verify_urls(short_urls: List[str], long_urls: List[str]) -> List[Tuple[str, str]]:
    async with aiohttp.ClientSession() as session:
        # Limit concurrent connections
        connector = aiohttp.TCPConnector(limit=10)
        async with aiohttp.ClientSession(connector=connector) as session:
            # Process in batches of 50
            batch_size = 50
            results = []
            
            for i in range(0, len(short_urls), batch_size):
                batch_short = short_urls[i:i + batch_size]
                batch_long = long_urls[i:i + batch_size]
                
                short_tasks = [fetch_url(session, url) for url in batch_short if url.strip()]
                long_tasks = [fetch_url(session, url) for url in batch_long if url.strip()]
                
                short_results = await asyncio.gather(*short_tasks)
                long_results = await asyncio.gather(*long_tasks)
                
                results.extend(zip(
                    [strip_tracking_params(url) for url in short_results],
                    long_results
                ))
                
                logger.info(f"Processed batch {i//batch_size + 1} ({len(results)}/{len(short_urls)} URLs)")
            
            return results

def get_column_data(worksheet, column, start_row=1):
    """
    Get data from a specific column starting from start_row
    column can be either a letter (A, B, C) or number (1, 2, 3)
    """
    # Convert column letter to number if necessary
    if isinstance(column, str):
        column = ord(column.upper()) - ord('A') + 1
    
    # Get all values from the column
    all_values = worksheet.col_values(column)
    
    # Return values starting from start_row (converting to 0-based index)
    return all_values[start_row - 1:]

def normalize_url_path(path: str) -> str:
    """Normalize URL path by removing /cl/s and trailing slashes"""
    # Remove trailing slashes
    path = path.rstrip('/')
    # Remove /cl/s pattern (common in shortened URLs)
    if path.endswith('/cl/s'):
        path = path[:-5]
    return path

def compare_urls(url1, url2):
    """
    Compare URLs by checking if they point to the same content
    Returns tuple of (match_type, details)
    """
    parsed1 = urlparse(url1)
    parsed2 = urlparse(url2)
    
    # Compare domains
    if parsed1.netloc != parsed2.netloc:
        return False, "Different domains"
    
    # Normalize and compare paths (ignoring case)
    path1 = normalize_url_path(parsed1.path)
    path2 = normalize_url_path(parsed2.path)
    
    if path1.lower() != path2.lower():
        return False, "Different paths"
    
    return True, "URLs match"

def load_sheet_data(gc, config: dict) -> pd.DataFrame:
    """Load and prepare data from a single sheet"""
    spreadsheet = gc.open_by_url(config['url'])
    worksheet = spreadsheet.worksheet(config['sheet_name'])
    
    ids = get_column_data(worksheet, config['id_column'], config['start_row'])
    urls = get_column_data(worksheet, config['url_column'], config['start_row'])
    
    df = pd.DataFrame({
        'id': pd.to_numeric(ids, errors='coerce'),
        'url': urls
    }).dropna()
    
    return df.sort_values('id')

def main():
    try:
        gc = gspread.service_account(filename='service_account.json')
        
        # Load data from both sheets
        logger.info("Loading data from sheets...")
        df1 = load_sheet_data(gc, SHEET_CONFIGS['sheet1'])
        df2 = load_sheet_data(gc, SHEET_CONFIGS['sheet2'])
        
        # Find common IDs and filter dataframes
        common_ids = set(df1['id']).intersection(set(df2['id']))
        if not common_ids:
            logger.error("No common IDs found between sheets")
            return
            
        # Filter dataframes to only include common IDs
        df1_filtered = df1[df1['id'].isin(common_ids)]
        df2_filtered = df2[df2['id'].isin(common_ids)]
        
        # Sort both dataframes by ID to ensure alignment
        df1_filtered = df1_filtered.sort_values('id')
        df2_filtered = df2_filtered.sort_values('id')
        
        # Get lists of URLs to verify
        urls1 = df1_filtered['url'].tolist()
        urls2 = df2_filtered['url'].tolist()
        
        logger.info(f"Found {len(common_ids)} common IDs between sheets")
        logger.info("Starting URL verification...")
        
        # Run the async URL verification
        results = asyncio.run(verify_urls(urls1, urls2))
        
        # Process results
        mismatches = []
        for i, (verified_url1, verified_url2) in enumerate(results):
            # Skip if URL2 is from web.archive.org
            if 'web.archive.org' in verified_url2:
                logger.info(f"Skipping comparison for ID {df1_filtered.iloc[i]['id']} - web.archive.org URL")
                continue
                
            matches, details = compare_urls(verified_url1, verified_url2)
            if not matches:
                mismatches.append({
                    'id': df1_filtered.iloc[i]['id'],
                    'url1': verified_url1,
                    'url2': verified_url2,
                    'details': details
                })
        
        # Log results
        logger.info(f"Verification complete. Found {len(mismatches)} mismatches (excluding web.archive.org URLs)")
        for mismatch in mismatches:
            logger.warning(f"Mismatch for ID {mismatch['id']}:")
            logger.warning(f"  URL1: {mismatch['url1']}")
            logger.warning(f"  URL2: {mismatch['url2']}")
            logger.warning(f"  Details: {mismatch['details']}")
            
    except Exception as e:
        logger.error(f"Fatal error: {str(e)}")
        raise

if __name__ == "__main__":
    main()
