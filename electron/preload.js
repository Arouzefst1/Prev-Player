const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // You can add IPC handlers here if needed
  appName: 'PREV Player',
  appVersion: '1.0.0',
});
