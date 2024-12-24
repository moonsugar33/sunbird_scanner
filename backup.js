import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { format } from 'date-fns';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Load environment variables
dotenv.config();

class DatabaseBackup {
  constructor() {
    // Initialize Supabase client
    this.supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    // Initialize S3 client
    this.s3Client = new S3Client({
      endpoint: `https://${process.env.S3_ENDPOINT}`,
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY
      },
      forcePathStyle: true,
      tls: true
    });

    // Backup configuration
    this.backupConfig = {
      tables: ['gv-links', 'sunbird'], // Add your table names here
      backupDir: './backups',
      s3Bucket: process.env.S3_BUCKET,
      s3Prefix: 'database-backups'
    };
  }

  async createBackupDir() {
    try {
      await fs.mkdir(this.backupConfig.backupDir, { recursive: true });
    } catch (error) {
      console.error('Error creating backup directory:', error);
      throw error;
    }
  }

  generateBackupFileName(tableName) {
    const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
    return `${tableName}_${timestamp}.sql`;
  }

  async getTableSchema(tableName) {
    try {
      const { data: columns, error } = await this.supabase
        .rpc('get_raw_schema', { table_name: tableName });

      if (error) throw error;

      return columns;
    } catch (error) {
      console.error(`Error fetching schema for ${tableName}:`, error);
      throw error;
    }
  }

  generateCreateTableStatement(tableName, schema) {
    let sql = `-- Backup of ${tableName} generated on ${new Date().toISOString()}\n\n`;
    sql += `DROP TABLE IF EXISTS ${tableName};\n`;
    sql += `CREATE TABLE ${tableName} (\n`;
    
    const columnDefinitions = schema.map(column => {
      let def = `  "${column.column_name}" ${column.data_type}`;
      
      // Add length/precision if specified
      if (column.character_maximum_length) {
        def += `(${column.character_maximum_length})`;
      }
      
      // Add nullable constraint
      if (column.is_nullable === 'NO') {
        def += ' NOT NULL';
      }
      
      // Add default value if exists
      if (column.column_default !== null) {
        def += ` DEFAULT ${column.column_default}`;
      }
      
      return def;
    });

    sql += columnDefinitions.join(',\n');
    sql += '\n);\n\n';
    
    return sql;
  }

  generateInsertStatements(tableName, data) {
    if (!data || data.length === 0) return '';
    
    const columns = Object.keys(data[0]);
    let sql = '';
    
    // Add INSERT statements
    data.forEach(row => {
      const values = columns.map(column => {
        const value = row[column];
        if (value === null) return 'NULL';
        if (typeof value === 'string') {
          return `'${value.replace(/'/g, "''")}'`;
        }
        if (typeof value === 'object') {
          return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
        }
        return value;
      });

      sql += `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${values.join(', ')});\n`;
    });

    return sql;
  }

  async backupTable(tableName) {
    try {
      console.log(`📦 Backing up table: ${tableName}`);
      
      // Get table schema
      const schema = await this.getTableSchema(tableName);
      
      // Fetch all data from the table
      const { data, error } = await this.supabase
        .from(tableName)
        .select('*');

      if (error) throw error;

      // Generate SQL file with schema and data
      const createTableSQL = this.generateCreateTableStatement(tableName, schema);
      const insertSQL = this.generateInsertStatements(tableName, data);
      const sql = createTableSQL + insertSQL;
      
      const fileName = this.generateBackupFileName(tableName);
      const filePath = path.join(this.backupConfig.backupDir, fileName);

      // Save to local file
      await fs.writeFile(filePath, sql, 'utf8');
      console.log(`💾 Saved local backup: ${fileName}`);

      // Upload to S3
      const s3Key = `${this.backupConfig.s3Prefix}/${fileName}`;
      const fileBuffer = await fs.readFile(filePath);
      
      try {
        const uploadCommand = new PutObjectCommand({
          Bucket: this.backupConfig.s3Bucket,
          Key: s3Key,
          Body: fileBuffer,
          ContentType: 'text/plain',
          ACL: 'private'
        });

        console.log('🔗 Attempting to upload to:', `https://${process.env.S3_ENDPOINT}/${this.backupConfig.s3Bucket}/${s3Key}`);
        await this.s3Client.send(uploadCommand);
        console.log('☁️ Uploaded to Vultr Object Storage:', s3Key);
      } catch (s3Error) {
        console.error('S3 Upload Error:', s3Error);
        throw new Error(`Failed to upload to Vultr Object Storage: ${s3Error.message}`);
      }

      return {
        success: true,
        fileName,
        s3Key
      };
    } catch (error) {
      console.error(`❌ Error backing up table ${tableName}:`, error);
      return {
        success: false,
        error: error.message,
        tableName
      };
    }
  }

  async backupAllTables() {
    try {
      console.log('🚀 Starting database backup...');
      
      // Create backup directory if it doesn't exist
      await this.createBackupDir();

      // Backup each table
      const results = await Promise.all(
        this.backupConfig.tables.map(tableName => this.backupTable(tableName))
      );

      // Generate summary
      const successful = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

      console.log('\n📊 Backup Summary');
      console.log('================');
      console.log(`✅ Successful: ${successful.length}`);
      console.log(`❌ Failed: ${failed.length}`);

      if (failed.length > 0) {
        console.log('\nFailed backups:');
        failed.forEach(f => console.log(`- ${f.tableName}: ${f.error}`));
      }

      return {
        timestamp: new Date().toISOString(),
        successful: successful.length,
        failed: failed.length,
        details: results
      };

    } catch (error) {
      console.error('Critical backup error:', error);
      throw error;
    }
  }
}

// Export the backup functionality
export const runBackup = async () => {
  const backup = new DatabaseBackup();
  return await backup.backupAllTables();
};

// Allow running directly from command line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runBackup()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Backup failed:', error);
      process.exit(1);
    });
}
