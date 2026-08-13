const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  login: data => ipcRenderer.invoke('auth:login', data),
  products: q => ipcRenderer.invoke('product:list', q),
  saveProduct: data => ipcRenderer.invoke('product:save', data),
  deleteProduct: data => ipcRenderer.invoke('product:delete', data),
  createSale: data => ipcRenderer.invoke('sale:create', data),
  sales: q => ipcRenderer.invoke('sale:list', q),
  returnSale: data => ipcRenderer.invoke('sale:return', data),
  createPurchase: data => ipcRenderer.invoke('purchase:create', data),
  debts: q => ipcRenderer.invoke('debt:list', q),
  payDebt: data => ipcRenderer.invoke('debt:pay', data),
  createExpense: data => ipcRenderer.invoke('expense:create', data),
  cash: () => ipcRenderer.invoke('cash:list'),
  report: q => ipcRenderer.invoke('report:summary', q),
  saveSettings: data => ipcRenderer.invoke('settings:save', data),
  exportBackup: () => ipcRenderer.invoke('backup:export'),
  importBackup: () => ipcRenderer.invoke('backup:import')
});
