const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const db = require('../src/db');
const services = require('../src/services');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 700,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

ipcMain.handle('app:init', () => services.snapshot());
ipcMain.handle('auth:login', (_, data) => services.login(data));
ipcMain.handle('product:list', (_, q) => services.products(q || {}));
ipcMain.handle('product:save', (_, data) => services.saveProduct(data));
ipcMain.handle('product:delete', (_, data) => services.deleteProduct(data));
ipcMain.handle('sale:create', (_, data) => services.createSale(data));
ipcMain.handle('sale:list', (_, data) => services.sales(data || {}));
ipcMain.handle('sale:return', (_, data) => services.returnSale(data));
ipcMain.handle('purchase:create', (_, data) => services.createPurchase(data));
ipcMain.handle('debt:list', (_, data) => services.debts(data || {}));
ipcMain.handle('debt:pay', (_, data) => services.payDebt(data));
ipcMain.handle('expense:create', (_, data) => services.createExpense(data));
ipcMain.handle('cash:list', () => services.cash());
ipcMain.handle('report:summary', (_, data) => services.report(data || {}));
ipcMain.handle('settings:save', (_, data) => services.saveSettings(data));
ipcMain.handle('backup:export', async () => {
  const result = await dialog.showSaveDialog({ defaultPath: `osama-market-backup-${new Date().toISOString().slice(0, 10)}.db` });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.copyFileSync(db.file, result.filePath);
  return { canceled: false, path: result.filePath };
});
ipcMain.handle('backup:import', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }] });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  db.replaceFrom(result.filePaths[0]);
  await db.init();
  return { canceled: false };
});

app.whenReady().then(async () => { await db.init(); createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
