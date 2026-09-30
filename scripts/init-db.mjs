// 初始化数据库：创建库并执行 db/schema.sql
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const cfg = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  multipleStatements: true,
};
const dbName = process.env.DB_NAME || 'uniform';

async function waitDb(conn) {
  for (let i = 0; i < 30; i++) {
    try { await conn.query('SELECT 1'); return; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
}

const conn = await mysql.createConnection(cfg);
await waitDb(conn);
await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
await conn.query(`USE \`${dbName}\``);
const sql = await readFile(path.join(root, 'db', 'schema.sql'), 'utf8');
await conn.query(sql);

// 轻量幂等列迁移：老库升级时补齐后加列（CREATE TABLE IF NOT EXISTS 不会改已有表）
async function ensureColumn(table, column, ddl) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) n FROM information_schema.columns
      WHERE table_schema=DATABASE() AND table_name=? AND column_name=?`, [table, column]);
  if (rows[0].n === 0) {
    await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
    console.log(`[init-db] migrated column ${table}.${column}`);
  }
}
await ensureColumn('distributions', 'frozen', 'frozen TINYINT(1) NOT NULL DEFAULT 0 COMMENT "错包冻结：仅冻结相关发放批次"');
await ensureColumn('distributions', 'freeze_reason', 'freeze_reason VARCHAR(200) NULL');
await ensureColumn('supplier_assessments', 'wrongpack_count', 'wrongpack_count INT NOT NULL DEFAULT 0');
await ensureColumn('supplier_assessments', 'wrongpack_delay_count', 'wrongpack_delay_count INT NOT NULL DEFAULT 0');

console.log(`[init-db] schema applied to database "${dbName}"`);
await conn.end();
