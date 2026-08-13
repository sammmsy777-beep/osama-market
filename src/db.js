const initSqlJs = require('sql.js');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const file = path.join(app.getPath('userData'), 'osama-market.sqlite3');
let connection;
const hashPin = value => crypto.createHash('sha256').update(String(value)).digest('hex');

class SqliteAdapter {
  constructor(raw) { this.raw = raw; this.inTransaction = false; }
  exec(sql) { this.raw.run(sql); if (!this.inTransaction) this.persist(); }
  prepare(sql) {
    const raw = this.raw;
    return {
      run: (...args) => { const stmt = raw.prepare(sql); stmt.bind(args); while (stmt.step()) {} stmt.free(); if (!this.inTransaction) this.persist(); return { lastInsertRowid: raw.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0] || 0 }; },
      get: (...args) => { const stmt = raw.prepare(sql); stmt.bind(args); const result = stmt.step() ? stmt.getAsObject() : undefined; stmt.free(); return result; },
      all: (...args) => { const stmt = raw.prepare(sql); stmt.bind(args); const out=[]; while(stmt.step()) out.push(stmt.getAsObject()); stmt.free(); return out; }
    };
  }
  transaction(fn) { return (...args) => { this.raw.run('BEGIN'); this.inTransaction=true; try { const value=fn(...args); this.raw.run('COMMIT'); this.inTransaction=false; this.persist(); return value; } catch (e) { try { this.raw.run('ROLLBACK'); } catch (_) {} this.inTransaction=false; throw e; } }; }
  persist() { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(this.raw.export())); }
  close() { this.persist(); }
}

async function init() {
  const SQL = await initSqlJs({ locateFile: name => path.join(path.dirname(require.resolve('sql.js')), name) });
  const raw = fs.existsSync(file) ? new SQL.Database(fs.readFileSync(file)) : new SQL.Database();
  connection = new SqliteAdapter(raw);
  raw.run('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  raw.run(`
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), store_name TEXT NOT NULL DEFAULT 'سوق أسامة', currency TEXT NOT NULL DEFAULT 'ل.س');
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, pin_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','cashier')), active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, barcode TEXT UNIQUE, category_id INTEGER REFERENCES categories(id), purchase_price REAL NOT NULL DEFAULT 0 CHECK(purchase_price>=0), sale_price REAL NOT NULL CHECK(sale_price>0), quantity REAL NOT NULL DEFAULT 0 CHECK(quantity>=0), min_quantity REAL NOT NULL DEFAULT 0 CHECK(min_quantity>=0), active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, notes TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, invoice_no INTEGER UNIQUE NOT NULL, customer_id INTEGER REFERENCES customers(id), payment_type TEXT NOT NULL CHECK(payment_type IN ('cash','debt')), subtotal REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, total REAL NOT NULL, cost_total REAL NOT NULL, profit_total REAL NOT NULL, status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','partial','returned','voided')), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), product_id INTEGER NOT NULL REFERENCES products(id), name_snapshot TEXT NOT NULL, quantity REAL NOT NULL CHECK(quantity>0), unit_price REAL NOT NULL, unit_cost REAL NOT NULL, discount REAL NOT NULL DEFAULT 0, line_total REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS sale_returns (id INTEGER PRIMARY KEY, sale_id INTEGER NOT NULL REFERENCES sales(id), type TEXT NOT NULL CHECK(type IN ('return','void')), reason TEXT, amount REAL NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sale_return_items (id INTEGER PRIMARY KEY, return_id INTEGER NOT NULL REFERENCES sale_returns(id), sale_item_id INTEGER NOT NULL REFERENCES sale_items(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity REAL NOT NULL, amount REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS purchases (id INTEGER PRIMARY KEY, invoice_no INTEGER UNIQUE NOT NULL, supplier_id INTEGER REFERENCES suppliers(id), payment_type TEXT NOT NULL CHECK(payment_type IN ('cash','debt')), total REAL NOT NULL, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS purchase_items (id INTEGER PRIMARY KEY, purchase_id INTEGER NOT NULL REFERENCES purchases(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity REAL NOT NULL, unit_price REAL NOT NULL, line_total REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS debts (id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('customer','supplier')), customer_id INTEGER REFERENCES customers(id), supplier_id INTEGER REFERENCES suppliers(id), source_type TEXT, source_id INTEGER, original_amount REAL NOT NULL, remaining_amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'active', due_date TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS debt_payments (id INTEGER PRIMARY KEY, debt_id INTEGER NOT NULL REFERENCES debts(id), amount REAL NOT NULL CHECK(amount>0), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cash_transactions (id INTEGER PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('sale','purchase','customer_payment','supplier_payment','expense','revenue','return')), amount REAL NOT NULL, reference_type TEXT, reference_id INTEGER, description TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS expenses (id INTEGER PRIMARY KEY, category TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0), description TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory_movements (id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id), type TEXT NOT NULL, quantity_in REAL NOT NULL DEFAULT 0, quantity_out REAL NOT NULL DEFAULT 0, unit_cost REAL NOT NULL DEFAULT 0, reference_type TEXT, reference_id INTEGER, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, entity_type TEXT, entity_id INTEGER, details TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode); CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(created_at); CREATE INDEX IF NOT EXISTS idx_debts_status ON debts(type,status); CREATE INDEX IF NOT EXISTS idx_cash_date ON cash_transactions(created_at); CREATE INDEX IF NOT EXISTS idx_audit_date ON audit_logs(created_at);
  `);
  if (!connection.prepare('SELECT COUNT(*) n FROM users').get().n) {
    connection.prepare("INSERT INTO settings(id,store_name,currency) VALUES(1,'سوق أسامة','ل.س')").run();
    connection.prepare("INSERT INTO users(id,username,display_name,pin_hash,role) VALUES(1,'owner','المالك',?,'owner'),(2,'cashier','أمين الصندوق',?,'cashier')").run(hashPin('1234'), hashPin('1111'));
    ['مواد غذائية','مشروبات','ألبان','منظفات','حلويات'].forEach(name => connection.prepare('INSERT INTO categories(name) VALUES(?)').run(name));
  }
  connection.persist();
}
function get() { if (!connection) throw new Error('قاعدة البيانات غير جاهزة'); return connection; }
function transaction(fn) { return get().transaction(fn)(); }
function replaceFrom(source) { connection.close(); fs.copyFileSync(source, file); connection = null; }
module.exports = { init, get, transaction, replaceFrom, file };
