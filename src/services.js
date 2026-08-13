const crypto = require('node:crypto');
const db = require('./db');
const sql = () => db.get();
let session = null;
const now = () => new Date().toISOString();
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function requireSession(role) { if (!session) throw new Error('يجب تسجيل الدخول'); if (role && session.role !== 'owner' && session.role !== role) throw new Error('لا تملك الصلاحية لهذه العملية'); }
function audit(action, entityType, entityId, details) { sql().prepare('INSERT INTO audit_logs(user_id,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,?,?,?)').run(session?.id || null, action, entityType, entityId || null, details || '', now()); }
function party(type, name) {
  const table = type === 'customer' ? 'customers' : 'suppliers';
  const found = sql().prepare(`SELECT id FROM ${table} WHERE name=? AND active=1`).get(name);
  if (found) return found.id;
  const result = sql().prepare(`INSERT INTO ${table}(name) VALUES(?)`).run(name);
  return result.lastInsertRowid;
}
function snapshot() {
  const s = sql();
  return { settings: s.prepare('SELECT * FROM settings WHERE id=1').get(), products: products({}), sales: sales({ limit: 20 }), debts: debts({}), cash: cash(), report: report({}), session };
}
function login({ username, pin }) {
  const user = sql().prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
  if (!user || user.pin_hash !== hash(pin)) throw new Error('بيانات الدخول غير صحيحة');
  session = { id: user.id, username: user.username, name: user.display_name, role: user.role };
  audit('LOGIN', 'user', user.id, 'تسجيل دخول');
  return session;
}
function products({ q = '', low = false } = {}) {
  let where = 'p.active=1'; const args = [];
  if (q) { where += ' AND (p.name LIKE ? OR p.barcode LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  if (low) where += ' AND p.quantity<=p.min_quantity';
  return sql().prepare(`SELECT p.*, c.name category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id WHERE ${where} ORDER BY p.name`).all(...args);
}
function saveProduct(data) {
  requireSession('owner');
  if (!data.name || Number(data.sale_price) <= 0 || Number(data.quantity) < 0) throw new Error('بيانات المنتج غير صحيحة');
  const s = sql(); const id = data.id ? Number(data.id) : null;
  if (id) s.prepare('UPDATE products SET name=?,barcode=?,category_id=?,purchase_price=?,sale_price=?,quantity=?,min_quantity=? WHERE id=?').run(data.name.trim(), data.barcode || null, data.category_id || null, Number(data.purchase_price) || 0, Number(data.sale_price), Number(data.quantity), Number(data.min_quantity) || 0, id);
  else { const r = s.prepare('INSERT INTO products(name,barcode,category_id,purchase_price,sale_price,quantity,min_quantity) VALUES(?,?,?,?,?,?,?)').run(data.name.trim(), data.barcode || null, data.category_id || null, Number(data.purchase_price) || 0, Number(data.sale_price), Number(data.quantity) || 0, Number(data.min_quantity) || 0); data.id = r.lastInsertRowid; }
  audit(id ? 'PRODUCT_UPDATE' : 'PRODUCT_CREATE', 'product', data.id, data.name); return products({});
}
function deleteProduct({ id }) { requireSession('owner'); sql().prepare('UPDATE products SET active=0 WHERE id=?').run(id); audit('PRODUCT_DELETE', 'product', id, 'تعطيل المنتج'); return true; }
function nextNumber(table, field) { return sql().prepare(`SELECT COALESCE(MAX(${field}),0)+1 n FROM ${table}`).get().n; }
function createSale({ items, payment_type = 'cash', customer_name = '', discount = 0 }) {
  requireSession(); if (!Array.isArray(items) || !items.length) throw new Error('السلة فارغة');
  return db.transaction(() => {
    const s = sql(); let subtotal = 0; let cost = 0; const rows = [];
    for (const item of items) { const p = s.prepare('SELECT * FROM products WHERE id=? AND active=1').get(item.product_id); const qty = Number(item.quantity); if (!p || qty <= 0 || p.quantity < qty) throw new Error(`المخزون غير كافٍ للمنتج: ${p?.name || ''}`); const line = p.sale_price * qty; subtotal += line; cost += p.purchase_price * qty; rows.push({ p, qty, line }); }
    const safeDiscount = Math.max(0, Math.min(Number(discount) || 0, subtotal)); const total = subtotal - safeDiscount; const profit = total - cost; const customerId = payment_type === 'debt' ? party('customer', customer_name.trim()) : null; const invoice = nextNumber('sales', 'invoice_no');
    const sale = s.prepare('INSERT INTO sales(invoice_no,customer_id,payment_type,subtotal,discount,total,cost_total,profit_total,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(invoice, customerId, payment_type, subtotal, safeDiscount, total, cost, profit, session.id, now()); const saleId = sale.lastInsertRowid;
    const insItem = s.prepare('INSERT INTO sale_items(sale_id,product_id,name_snapshot,quantity,unit_price,unit_cost,discount,line_total) VALUES(?,?,?,?,?,?,?,?)'); const update = s.prepare('UPDATE products SET quantity=quantity-? WHERE id=?'); const move = s.prepare("INSERT INTO inventory_movements(product_id,type,quantity_out,unit_cost,reference_type,reference_id,created_by,created_at) VALUES(?,'sale',?,?,?,?,?,?)");
    rows.forEach(r => { const item = insItem.run(saleId, r.p.id, r.p.name, r.qty, r.p.sale_price, r.p.purchase_price, safeDiscount * (r.line / subtotal), r.line); update.run(r.qty, r.p.id); move.run(r.p.id, r.qty, r.p.purchase_price, 'sale', saleId, session.id, now()); });
    if (payment_type === 'cash') s.prepare("INSERT INTO cash_transactions(type,amount,reference_type,reference_id,description,created_by,created_at) VALUES('sale',?,?,?,?,?,?)").run(total, 'sale', saleId, `بيع فاتورة #${invoice}`, session.id, now());
    else s.prepare('INSERT INTO debts(type,customer_id,source_type,source_id,original_amount,remaining_amount,created_at) VALUES(\'customer\',?,?,?,?,?,?)').run(customerId, 'sale', saleId, total, total, now());
    audit('SALE_CREATE', 'sale', saleId, `فاتورة #${invoice}`); return { id: saleId, invoice_no: invoice, total, profit };
  });
}
function sales({ limit = 100 } = {}) { return sql().prepare('SELECT s.*, c.name customer_name FROM sales s LEFT JOIN customers c ON c.id=s.customer_id ORDER BY s.id DESC LIMIT ?').all(Number(limit)); }
function returnSale({ sale_id, type = 'return', items, reason = '' }) {
  requireSession(); if (session.role !== 'owner') throw new Error('المرتجعات تتطلب موافقة المالك');
  return db.transaction(() => {
    const s = sql(); const sale = s.prepare('SELECT * FROM sales WHERE id=?').get(sale_id); if (!sale || sale.status === 'voided' || sale.status === 'returned') throw new Error('الفاتورة غير قابلة للمعالجة');
    const original = s.prepare('SELECT * FROM sale_items WHERE sale_id=?').all(sale_id); const chosen = type === 'void' ? original.map(i => ({ ...i, return_quantity: i.quantity })) : (items || []).map(x => { const row=s.prepare('SELECT * FROM sale_items WHERE id=?').get(x.sale_item_id); return row ? ({ ...row, return_quantity:Number(x.quantity) }) : null; }).filter(Boolean);
    const returned = s.prepare('SELECT sale_item_id, COALESCE(SUM(quantity),0) quantity FROM sale_return_items GROUP BY sale_item_id');
    const already = new Map(returned.all().map(x => [Number(x.sale_item_id), Number(x.quantity)]));
    if (!chosen.length || chosen.some(x => !x.id || x.return_quantity <= 0 || x.return_quantity + (already.get(x.id) || 0) > x.quantity)) throw new Error('كميات المرتجع غير صحيحة');
    let amount = 0; chosen.forEach(x => { amount += x.unit_price * x.return_quantity; s.prepare('UPDATE products SET quantity=quantity+? WHERE id=?').run(x.return_quantity, x.product_id); s.prepare("INSERT INTO inventory_movements(product_id,type,quantity_in,unit_cost,reference_type,reference_id,created_by,created_at) VALUES(?,'return',?,?,?,?,?,?)").run(x.product_id, x.return_quantity, x.unit_cost, 'sale_return', sale_id, session.id, now()); });
    const ret = s.prepare('INSERT INTO sale_returns(sale_id,type,reason,amount,created_by,created_at) VALUES(?,?,?,?,?,?)').run(sale_id, type, reason, amount, session.id, now()); const ir = s.prepare('INSERT INTO sale_return_items(return_id,sale_item_id,product_id,quantity,amount) VALUES(?,?,?,?,?)'); chosen.forEach(x => ir.run(ret.lastInsertRowid, x.id, x.product_id, x.return_quantity, x.unit_price * x.return_quantity));
    if (sale.payment_type === 'cash') s.prepare("INSERT INTO cash_transactions(type,amount,reference_type,reference_id,description,created_by,created_at) VALUES('return',?,?,?,?,?,?)").run(-amount, 'sale_return', ret.lastInsertRowid, `مرتجع فاتورة #${sale.invoice_no}`, session.id, now());
    else { const debt = s.prepare("SELECT * FROM debts WHERE source_type='sale' AND source_id=?").get(sale_id); if (debt) s.prepare('UPDATE debts SET remaining_amount=MAX(0,remaining_amount-?) WHERE id=?').run(amount, debt.id); }
    const full = type === 'void' || chosen.every(x => x.return_quantity + (already.get(x.id) || 0) >= x.quantity); s.prepare('UPDATE sales SET total=MAX(0,total-?), profit_total=profit_total-?, status=? WHERE id=?').run(amount, Math.max(0, amount - chosen.reduce((a,x) => a + x.unit_cost*x.return_quantity, 0)), full ? (type === 'void' ? 'voided' : 'returned') : 'partial', sale_id);
    audit(type === 'void' ? 'SALE_VOID' : 'SALE_RETURN', 'sale', sale_id, reason); return { amount };
  });
}
function createPurchase({ supplier_name, payment_type = 'cash', items }) { requireSession('owner'); if (!supplier_name || !items?.length) throw new Error('بيانات الشراء غير مكتملة'); return db.transaction(() => { const s=sql(); const supplierId=party('supplier',supplier_name.trim()); const rows=items.map(i=>{const p=s.prepare('SELECT * FROM products WHERE id=?').get(i.product_id); if(!p||Number(i.quantity)<=0) throw new Error('صنف شراء غير صحيح'); return {p,quantity:Number(i.quantity),price:Number(i.unit_price)||p.purchase_price};}); const total=rows.reduce((a,r)=>a+r.quantity*r.price,0); const no=nextNumber('purchases','invoice_no'); const pur=s.prepare('INSERT INTO purchases(invoice_no,supplier_id,payment_type,total,created_by,created_at) VALUES(?,?,?,?,?,?)').run(no,supplierId,payment_type,total,session.id,now()); const add=s.prepare('UPDATE products SET quantity=quantity+?,purchase_price=? WHERE id=?'); const pi=s.prepare('INSERT INTO purchase_items(purchase_id,product_id,quantity,unit_price,line_total) VALUES(?,?,?,?,?)'); rows.forEach(r=>{pi.run(pur.lastInsertRowid,r.p.id,r.quantity,r.price,r.quantity*r.price);add.run(r.quantity,r.price,r.p.id);s.prepare("INSERT INTO inventory_movements(product_id,type,quantity_in,unit_cost,reference_type,reference_id,created_by,created_at) VALUES(?,'purchase',?,?,?,?,?,?)").run(r.p.id,r.quantity,r.price,'purchase',pur.lastInsertRowid,session.id,now());}); if(payment_type==='cash')s.prepare("INSERT INTO cash_transactions(type,amount,reference_type,reference_id,description,created_by,created_at) VALUES('purchase',?,?,?,?,?,?)").run(-total,'purchase',pur.lastInsertRowid,`شراء فاتورة #${no}`,session.id,now()); else s.prepare('INSERT INTO debts(type,supplier_id,source_type,source_id,original_amount,remaining_amount,created_at) VALUES(\'supplier\',?,?,?,?,?,?)').run(supplierId,'purchase',pur.lastInsertRowid,total,total,now()); audit('PURCHASE_CREATE','purchase',pur.lastInsertRowid,`فاتورة #${no}`); return { invoice_no:no,total }; }); }
function debts({ type }={}) { return sql().prepare(`SELECT d.*, COALESCE(c.name,s.name) party_name FROM debts d LEFT JOIN customers c ON c.id=d.customer_id LEFT JOIN suppliers s ON s.id=d.supplier_id ${type ? 'WHERE d.type=?' : ''} ORDER BY d.id DESC`).all(...(type ? [type] : [])); }
function payDebt({ debt_id, amount }) { requireSession(); return db.transaction(() => { const s=sql(); const d=s.prepare('SELECT * FROM debts WHERE id=?').get(debt_id); const value=Number(amount); if(!d||value<=0||value>d.remaining_amount)throw new Error('مبلغ الدفعة غير صحيح'); s.prepare('UPDATE debts SET remaining_amount=remaining_amount-?,status=CASE WHEN remaining_amount-?<=0 THEN \'settled\' ELSE \'active\' END WHERE id=?').run(value,value,debt_id); s.prepare('INSERT INTO debt_payments(debt_id,amount,created_by,created_at) VALUES(?,?,?,?)').run(debt_id,value,session.id,now()); const type=d.type==='customer'?'customer_payment':'supplier_payment'; s.prepare(`INSERT INTO cash_transactions(type,amount,reference_type,reference_id,description,created_by,created_at) VALUES(?,?,?,?,?,?,?)`).run(type,d.type==='customer'?value:-value,'debt',debt_id,'دفعة دين',session.id,now()); audit('DEBT_PAYMENT','debt',debt_id,`دفعة ${value}`); return true; }); }
function createExpense({ category, amount, description='' }) { requireSession('owner'); const value=Number(amount); if(!category||value<=0)throw new Error('بيانات المصروف غير صحيحة'); return db.transaction(()=>{const s=sql();const r=s.prepare('INSERT INTO expenses(category,amount,description,created_by,created_at) VALUES(?,?,?,?,?)').run(category,value,description,session.id,now());s.prepare("INSERT INTO cash_transactions(type,amount,reference_type,reference_id,description,created_by,created_at) VALUES('expense',?,?,?,?,?,?)").run(-value,'expense',r.lastInsertRowid,description,session.id,now());audit('EXPENSE_CREATE','expense',r.lastInsertRowid,description);return true;}); }
function cash() { const rows=sql().prepare('SELECT * FROM cash_transactions ORDER BY id DESC LIMIT 200').all(); return { rows, balance: rows.reduce((a,r)=>a+r.amount,0) }; }
function report({ from, to }={}) { const s=sql(); const dateWhere=from&&to?'WHERE created_at BETWEEN ? AND ?':''; const args=from&&to?[from,to]:[]; const salesTotal=s.prepare(`SELECT COALESCE(SUM(total),0) total,COALESCE(SUM(profit_total),0) profit FROM sales WHERE status<>\'voided\' ${from&&to?'AND created_at BETWEEN ? AND ?':''}`).get(...args); const purchases=s.prepare(`SELECT COALESCE(SUM(total),0) total FROM purchases ${dateWhere}`).get(...args).total; const debtsTotal=s.prepare('SELECT COALESCE(SUM(CASE WHEN type=\'customer\' THEN remaining_amount ELSE 0 END),0) customer,COALESCE(SUM(CASE WHEN type=\'supplier\' THEN remaining_amount ELSE 0 END),0) supplier FROM debts').get(); return { sales:salesTotal.total, profit:salesTotal.profit, purchases, customer_debt:debtsTotal.customer, supplier_debt:debtsTotal.supplier, inventory_value:s.prepare('SELECT COALESCE(SUM(quantity*purchase_price),0) v FROM products WHERE active=1').get().v, cash:cash().balance }; }
function saveSettings(data) { requireSession('owner'); sql().prepare('UPDATE settings SET store_name=?,currency=? WHERE id=1').run(data.store_name || 'سوق أسامة', data.currency || 'ل.س'); audit('SETTINGS','settings',1,'تحديث الإعدادات'); return sql().prepare('SELECT * FROM settings WHERE id=1').get(); }
module.exports = { init: db.init, snapshot, login, products, saveProduct, deleteProduct, createSale, sales, returnSale, createPurchase, debts, payDebt, createExpense, cash, report, saveSettings };
