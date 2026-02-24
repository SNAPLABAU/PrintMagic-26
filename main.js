const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');

let mainWindow;
let dialogueWindow = null;
let watcher = null;
let printerPool = [];
let jobQueue = [];
let processingJobs = new Set();
let jobHistory = [];
let pendingDialogueJobs = []; // Jobs awaiting user confirmation

let config = {
  inFolder: '',
  pendingFolder: '',
  printedFolder: '',
  stashFolder: '',
  defaultSides: 'one-sided',
  winPrintMethod: 'electron'   // 'electron' | 'sumatra'
};

// Config persistence
const configPath = path.join(app.getPath('userData'), 'config.json');
const printerPoolPath = path.join(app.getPath('userData'), 'printers.json');

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
    }
    if (fs.existsSync(printerPoolPath)) {
      printerPool = JSON.parse(fs.readFileSync(printerPoolPath, 'utf8'));
    }
  } catch (e) {
    console.error('Config load error:', e);
  }
}

function saveConfig() {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function savePrinterPool() {
  fs.writeFileSync(printerPoolPath, JSON.stringify(printerPool, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'win32',
    backgroundColor: '#0d0d0f',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile('index.html');
  loadConfig();

  // Start watching only after renderer is ready so dialogue events aren't lost
  mainWindow.webContents.on('did-finish-load', () => {
    if (config.inFolder && fs.existsSync(config.inFolder)) {
      startWatcher();
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── Folder Management ──────────────────────────────────────────────────────────

ipcMain.handle('select-folder', async (event, type) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: `Select ${type.replace(/([A-Z])/g, ' $1').toLowerCase()} folder`
  });
  if (!result.canceled && result.filePaths[0]) {
    const folderPath = result.filePaths[0];
    config[type] = folderPath;

    // Create folder if it doesn't exist
    fs.mkdirSync(folderPath, { recursive: true });

    // If selecting inFolder, auto-create sibling workflow folders
    if (type === 'inFolder') {
      const parentDir = path.dirname(folderPath);
      const autoFolders = {
        pendingFolder: path.join(parentDir, 'pending'),
        printedFolder: path.join(parentDir, 'printed'),
        stashFolder: path.join(parentDir, 'stash')
      };
      for (const [key, sibPath] of Object.entries(autoFolders)) {
        fs.mkdirSync(sibPath, { recursive: true });
        if (!config[key]) config[key] = sibPath;
      }
      saveConfig();
      startWatcher();
    } else {
      saveConfig();
    }

    return { path: folderPath, config };
  }
  return null;
});

ipcMain.handle('select-workspace', async (event) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Workspace — in / pending / printed / stash created inside'
  });
  if (!result.canceled && result.filePaths[0]) {
    const ws = result.filePaths[0];
    const folders = {
      inFolder: path.join(ws, 'in'),
      pendingFolder: path.join(ws, 'pending'),
      printedFolder: path.join(ws, 'printed'),
      stashFolder: path.join(ws, 'stash')
    };
    for (const [key, folderPath] of Object.entries(folders)) {
      fs.mkdirSync(folderPath, { recursive: true });
      config[key] = folderPath;
    }
    saveConfig();
    startWatcher();
    return { workspacePath: ws, config };
  }
  return null;
});

ipcMain.handle('get-config', () => config);
ipcMain.handle('open-folder', (event, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) shell.openPath(folderPath);
});

// ── File Watcher ───────────────────────────────────────────────────────────────

function startWatcher() {
  if (watcher) watcher.close();
  if (!config.inFolder || !fs.existsSync(config.inFolder)) return;

  watcher = chokidar.watch(config.inFolder, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 }
  });

  watcher.on('add', (filePath) => {
    const filename = path.basename(filePath);
    if (filename.startsWith('.') || filename.startsWith('~')) return;

    const job = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 11),
      filename,
      filePath,
      status: 'awaiting-confirmation',
      addedAt: new Date().toISOString(),
      printer: null,
      attempts: 0
    };

    pendingDialogueJobs.push(job);
    showNextDialogue(); // creates window or updates existing with new queue count
    mainWindow?.webContents.send('queue-updated', getQueueState());
  });

  mainWindow?.webContents.send('watcher-status', { active: true, folder: config.inFolder });
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    mainWindow?.webContents.send('watcher-status', { active: false });
  }
}

function getDialogueData() {
  const job = pendingDialogueJobs[0];
  return {
    job: { id: job.id, filename: job.filename, filePath: job.filePath },
    printers: printerPool.filter(p => p.enabled && !p.paused),
    allPrinters: printerPool,
    queueCount: pendingDialogueJobs.length,
    defaultSides: config.defaultSides || 'one-sided'
  };
}

function showNextDialogue() {
  if (pendingDialogueJobs.length === 0) {
    if (dialogueWindow && !dialogueWindow.isDestroyed()) {
      dialogueWindow.close();
    }
    return;
  }

  // If window already exists, just update it
  if (dialogueWindow && !dialogueWindow.isDestroyed()) {
    dialogueWindow.webContents.send('update-dialogue', getDialogueData());
    if (!dialogueWindow.isVisible()) dialogueWindow.show();
    dialogueWindow.focus();
    return;
  }

  createDialogueWindow();
}

function createDialogueWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  dialogueWindow = new BrowserWindow({
    width: 640,
    height: 320,
    x: Math.round((width - 640) / 2),
    y: Math.round((height - 320) / 2),
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#0a0a0c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload-dialogue.js')
    }
  });

  dialogueWindow.loadFile('dialogue.html');
  dialogueWindow.setAlwaysOnTop(true, 'screen-saver');

  dialogueWindow.webContents.on('did-finish-load', () => {
    dialogueWindow.webContents.send('init-dialogue', getDialogueData());
    dialogueWindow.show();
    dialogueWindow.focus();
  });

  dialogueWindow.on('closed', () => {
    dialogueWindow = null;
  });
}

// ── Dialogue Actions ───────────────────────────────────────────────────────────

ipcMain.handle('confirm-print', async (event, { jobId, printerName, sides }) => {
  const idx = pendingDialogueJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return { error: 'Job not found' };

  const job = pendingDialogueJobs.splice(idx, 1)[0];
  const printer = printerPool.find(p => p.name === printerName);
  if (!printer) return { error: 'Printer not available' };

  job.status = 'queued';
  job.printer = printerName;
  job.sides = sides || 'one-sided';

  jobQueue.push(job);
  mainWindow?.webContents.send('queue-updated', getQueueState());
  processQueue();

  setTimeout(showNextDialogue, 200);
  return { success: true };
});

ipcMain.handle('stash-job', async (event, jobId) => {
  const idx = pendingDialogueJobs.findIndex(j => j.id === jobId);
  if (idx === -1) return { error: 'Job not found' };

  const job = pendingDialogueJobs.splice(idx, 1)[0];

  // Resolve stash folder — auto-derive if not configured
  let stashFolder = config.stashFolder;
  if (!stashFolder && config.inFolder) {
    stashFolder = path.join(path.dirname(config.inFolder), 'stash');
    config.stashFolder = stashFolder;
    saveConfig();
  }
  if (!stashFolder) {
    job.status = 'stashed';
    job.completedAt = new Date().toISOString();
    jobHistory.unshift(job);
    if (jobHistory.length > 100) jobHistory.pop();
    mainWindow?.webContents.send('queue-updated', getQueueState());
    setTimeout(showNextDialogue, 300);
    return { success: true, warning: 'No stash folder — file left in inbox' };
  }

  fs.mkdirSync(stashFolder, { recursive: true });

  if (fs.existsSync(job.filePath)) {
    let destPath = path.join(stashFolder, job.filename);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      const ext = path.extname(job.filename);
      const base = path.basename(job.filename, ext);
      destPath = path.join(stashFolder, `${base}_${counter}${ext}`);
      counter++;
    }
    fs.copyFileSync(job.filePath, destPath);
    try { fs.unlinkSync(job.filePath); } catch (e) { /* ignore */ }
    job.stashPath = destPath;
  }

  job.status = 'stashed';
  job.completedAt = new Date().toISOString();
  jobHistory.unshift(job);
  if (jobHistory.length > 100) jobHistory.pop();

  mainWindow?.webContents.send('queue-updated', getQueueState());
  setTimeout(showNextDialogue, 300);
  return { success: true };
});

ipcMain.handle('get-stash-files', () => {
  if (!config.stashFolder || !fs.existsSync(config.stashFolder)) return [];
  try {
    return fs.readdirSync(config.stashFolder)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const fp = path.join(config.stashFolder, f);
        const stat = fs.statSync(fp);
        return { filename: f, path: fp, addedAt: stat.mtime.toISOString(), size: stat.size };
      })
      .sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
  } catch { return []; }
});

ipcMain.handle('reprint-stash', async (event, filename) => {
  if (!config.stashFolder || !config.inFolder) return { error: 'Folders not configured' };
  const stashPath = path.join(config.stashFolder, filename);
  if (!fs.existsSync(stashPath)) return { error: 'File not found in stash' };

  let destPath = path.join(config.inFolder, filename);
  let counter = 1;
  while (fs.existsSync(destPath)) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    destPath = path.join(config.inFolder, `${base}_${counter}${ext}`);
    counter++;
  }
  fs.copyFileSync(stashPath, destPath);
  fs.unlinkSync(stashPath);
  return { success: true };
});

ipcMain.handle('delete-stash', async (event, filename) => {
  if (!config.stashFolder) return { error: 'Stash folder not configured' };
  const filePath = path.join(config.stashFolder, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return { success: true };
});

ipcMain.handle('pause-printer', (event, printerId) => {
  const p = printerPool.find(p => p.id === printerId);
  if (p) {
    p.paused = !p.paused;
    savePrinterPool();
    mainWindow?.webContents.send('printers-updated', printerPool);
    // Refresh dialogue window printer list if open
    if (dialogueWindow && !dialogueWindow.isDestroyed() && pendingDialogueJobs.length > 0) {
      dialogueWindow.webContents.send('update-dialogue', getDialogueData());
    }
  }
  return printerPool;
});

ipcMain.handle('close-dialogue', () => {
  if (dialogueWindow && !dialogueWindow.isDestroyed()) {
    dialogueWindow.close();
  }
});

ipcMain.handle('dialogue-toggle-panel', () => {
  if (!dialogueWindow || dialogueWindow.isDestroyed()) return false;
  const [w, h] = dialogueWindow.getSize();
  const normalW = 640;
  const expandedW = 860;
  const isExpanded = w >= expandedW;
  dialogueWindow.setSize(isExpanded ? normalW : expandedW, h);
  return !isExpanded;
});

ipcMain.handle('update-config', (event, updates) => {
  config = { ...config, ...updates };
  saveConfig();
  return config;
});

// ── Print Queue ────────────────────────────────────────────────────────────────

async function processQueue() {
  if (jobQueue.length === 0) return;

  const availablePrinters = printerPool.filter(p => p.enabled && !p.paused && p.status !== 'busy');
  if (availablePrinters.length === 0) return;

  const job = jobQueue.find(j => j.status === 'queued' && !processingJobs.has(j.id));
  if (!job) return;

  // Use job's assigned printer if it's available, else use pool order
  let printer = job.printer ? availablePrinters.find(p => p.name === job.printer) : null;
  if (!printer) printer = availablePrinters[0];
  if (!printer) return;

  processingJobs.add(job.id);
  job.status = 'processing';
  job.printer = printer.name;
  job.startedAt = new Date().toISOString();

  updatePrinterStatus(printer.id, 'busy', job.filename);
  mainWindow?.webContents.send('queue-updated', getQueueState());

  try {
    if (config.pendingFolder) {
      fs.mkdirSync(config.pendingFolder, { recursive: true });
      const pendingPath = path.join(config.pendingFolder, job.filename);
      fs.copyFileSync(job.filePath, pendingPath);
      try { fs.unlinkSync(job.filePath); } catch (e) { /* ignore */ }
      job.pendingPath = pendingPath;
    }

    await sendToPrinter(job, printer);

    job.status = 'printed';
    job.completedAt = new Date().toISOString();

    if (config.printedFolder && job.pendingPath) {
      fs.mkdirSync(config.printedFolder, { recursive: true });
      let destPath = path.join(config.printedFolder, job.filename);
      let counter = 1;
      while (fs.existsSync(destPath)) {
        const ext = path.extname(job.filename);
        const base = path.basename(job.filename, ext);
        destPath = path.join(config.printedFolder, `${base}_${counter}${ext}`);
        counter++;
      }
      fs.renameSync(job.pendingPath, destPath);
      job.printedPath = destPath;
    }
  } catch (err) {
    job.status = 'error';
    job.error = err.message;
    job.completedAt = new Date().toISOString();
    console.error('Print error:', err);
  }

  const idx = jobQueue.indexOf(job);
  if (idx > -1) jobQueue.splice(idx, 1);
  jobHistory.unshift(job);
  if (jobHistory.length > 100) jobHistory.pop();

  processingJobs.delete(job.id);
  updatePrinterStatus(printer.id, 'online', null);
  mainWindow?.webContents.send('queue-updated', getQueueState());

  setTimeout(processQueue, 500);
}

// Use Electron's built-in Chromium renderer to print any file on Windows.
// This avoids external tools (SumatraPDF, wscript) and works with the native
// Windows print spooler directly.
function electronPrint(filePath, printerName, options) {
  return new Promise((resolve, reject) => {
    const sides = options?.sides || 'one-sided';
    const fileUrl = require('url').pathToFileURL(filePath).toString();

    const win = new BrowserWindow({ show: false, webPreferences: { plugins: true } });
    win.loadURL(fileUrl);

    win.webContents.once('did-finish-load', () => {
      // Short delay so PDF renderer has time to fully initialise
      setTimeout(() => {
        const printOpts = { silent: true, deviceName: printerName || '', printBackground: false };
        if (sides === 'two-sided-long-edge') printOpts.duplexMode = 'longEdge';
        else if (sides === 'two-sided-short-edge') printOpts.duplexMode = 'shortEdge';
        win.webContents.print(printOpts, (success, reason) => {
          win.destroy();
          if (success) resolve();
          else reject(new Error(reason || 'Print failed'));
        });
      }, 600);
    });

    win.webContents.once('did-fail-load', (event, code, desc) => {
      win.destroy();
      reject(new Error(desc || 'Failed to load file for printing'));
    });
  });
}

async function sendToPrinter(job, printer) {
  const ext = path.extname(job.filename).toLowerCase();
  const filePath = job.pendingPath || job.filePath;
  const sides = job.sides || 'one-sided';
  const rawExts = ['.zpl', '.epl', '.raw'];

  // On Windows: RAW/label files always go through node-printer.
  // For everything else, route based on the user's chosen print method.
  if (process.platform === 'win32') {
    if (printer.type === 'raw' || printer.rawMode || rawExts.includes(ext)) {
      try {
        const nodePrinter = require('node-printer');
        const data = fs.readFileSync(filePath);
        return new Promise((resolve, reject) => {
          nodePrinter.printDirect({ data, printer: printer.name, type: printer.dataType || 'RAW', success: resolve, error: reject });
        });
      } catch (err) { /* node-printer not available, fall through */ }
    }
    if (config.winPrintMethod === 'sumatra') {
      return new Promise((resolve, reject) => osPrintPDF(filePath, printer.name, { sides }, resolve, reject));
    }
    return electronPrint(filePath, printer.name, { sides });
  }

  // macOS / Linux: existing logic
  return new Promise((resolve, reject) => {
    if (ext === '.pdf') {
      osPrintPDF(filePath, printer.name, { sides }, resolve, reject);
      return;
    }
    try {
      const nodePrinter = require('node-printer');
      if (printer.type === 'raw' || printer.rawMode) {
        const data = fs.readFileSync(filePath);
        nodePrinter.printDirect({ data, printer: printer.name, type: printer.dataType || 'RAW', success: resolve, error: reject });
      } else {
        const data = fs.readFileSync(filePath);
        nodePrinter.printDirect({ data, printer: printer.name, type: getDataType(ext), success: resolve, error: reject });
      }
    } catch (err) {
      osPrint(filePath, printer.name, { sides }, resolve, reject);
    }
  });
}

// PDF printing at actual size (no scaling) via CUPS / OS
function osPrintPDF(filePath, printerName, options, resolve, reject) {
  const { exec } = require('child_process');
  const sides = options?.sides || 'one-sided';
  const safeFile = filePath.replace(/"/g, '\\"');
  const safePrinter = printerName ? printerName.replace(/"/g, '\\"') : '';

  let cmd;
  if (process.platform === 'win32') {
    // SumatraPDF: path must NOT be pre-quoted here — the template literal adds quotes.
    const sumatra = 'C:\\Program Files\\SumatraPDF\\SumatraPDF.exe';
    if (safePrinter) {
      cmd = `"${sumatra}" -print-to "${safePrinter}" -print-settings "fit=none" "${safeFile}" 2>nul`;
    } else {
      cmd = `"${sumatra}" -print-dialog "${safeFile}" 2>nul`;
    }
  } else {
    // macOS / Linux — CUPS lp
    // fit-to-page=no = actual size (document DPI, no scaling)
    const printerOpt = safePrinter ? `-d "${safePrinter}"` : '';
    cmd = `lp ${printerOpt} -o fit-to-page=no -o sides=${sides} "${safeFile}"`;
  }

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err && !stdout) {
      // Fallback for Windows if SumatraPDF not found
      if (process.platform === 'win32') {
        const fallback = `powershell -Command "Start-Process -FilePath '${safeFile}' -Verb PrintTo -ArgumentList '${safePrinter}'"`;
        exec(fallback, { timeout: 30000 }, (err2, out2, err2s) => {
          if (err2) reject(new Error(err2s || err2.message));
          else resolve(out2);
        });
      } else {
        reject(new Error(stderr || err.message));
      }
    } else {
      resolve(stdout);
    }
  });
}

function osPrint(filePath, printerName, options, resolve, reject) {
  const { exec } = require('child_process');
  const sides = options?.sides || 'one-sided';
  const safeFile = filePath.replace(/"/g, '\\"');
  const safePrinter = printerName ? printerName.replace(/"/g, '\\"') : '';

  let cmd;
  if (process.platform === 'win32') {
    cmd = safePrinter
      ? `powershell -Command "Start-Process -FilePath '${safeFile}' -Verb PrintTo -ArgumentList '${safePrinter}'"`
      : `powershell -Command "Start-Process -FilePath '${safeFile}' -Verb Print"`;
  } else {
    const printerOpt = safePrinter ? `-d "${safePrinter}"` : '';
    cmd = `lp ${printerOpt} -o sides=${sides} "${safeFile}"`;
  }

  exec(cmd, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err && !stdout) reject(new Error(stderr || err.message));
    else resolve(stdout);
  });
}

function getDataType(ext) {
  const map = {
    '.pdf': 'PDF',
    '.txt': 'TEXT',
    '.ps': 'POSTSCRIPT',
    '.zpl': 'RAW',
    '.epl': 'RAW',
    '.raw': 'RAW'
  };
  return map[ext] || 'AUTO';
}

// ── Printer Pool Management ────────────────────────────────────────────────────

ipcMain.handle('get-system-printers', async () => {
  // Use Electron's built-in printer API — most reliable cross-platform.
  try {
    if (mainWindow && mainWindow.webContents) {
      const printers = await mainWindow.webContents.getPrintersAsync();
      if (printers && printers.length > 0) {
        return printers.map(p => ({ name: p.name, status: 'Ready' })).filter(p => p.name);
      }
    }
  } catch (e) {
    // fall through
  }
  // Fallback: shell commands
  if (process.platform !== 'win32') {
    try {
      const nodePrinter = require('node-printer');
      return nodePrinter.getPrinters();
    } catch (e) {
      // fall through
    }
  }
  return getSystemPrintersFallback();
});

function getSystemPrintersFallback() {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    if (process.platform === 'win32') {
      // PowerShell Get-Printer works on Windows 10 and 11.
      // wmic is deprecated and removed from many Windows 11 builds.
      const cmd = 'powershell -NoProfile -NonInteractive -Command "Get-Printer | Select-Object Name,DriverName | ConvertTo-Json -Compress"';
      exec(cmd, { timeout: 12000 }, (err, stdout) => {
        if (err || !stdout?.trim()) {
          // Last-resort: wmic for very old Windows 10 builds
          exec('wmic printer get name /value', { timeout: 8000 }, (err2, stdout2) => {
            if (err2) return resolve([]);
            const printers = (stdout2 || '').split('\n')
              .filter(l => l.trim().startsWith('Name='))
              .map(l => ({ name: l.replace('Name=', '').trim(), status: 'Unknown' }))
              .filter(p => p.name);
            resolve(printers);
          });
          return;
        }
        try {
          let data = JSON.parse(stdout.trim());
          if (!Array.isArray(data)) data = [data];
          resolve(data.map(p => ({ name: p.Name, status: 'Ready' })).filter(p => p.name));
        } catch {
          resolve([]);
        }
      });
    } else {
      exec('lpstat -p', (err, stdout) => {
        if (err) return resolve([]);
        const printers = (stdout || '').split('\n')
          .filter(l => l.startsWith('printer'))
          .map(l => ({ name: l.split(' ')[1], status: 'Unknown' }))
          .filter(p => p.name);
        resolve(printers);
      });
    }
  });
}

ipcMain.handle('get-printer-pool', () => printerPool);

ipcMain.handle('add-printer', (event, printer) => {
  const exists = printerPool.find(p => p.id === printer.id);
  if (!exists) {
    printerPool.push({
      ...printer,
      status: 'online',
      enabled: true,
      paused: false,
      jobCount: 0
    });
    savePrinterPool();
  }
  return printerPool;
});

ipcMain.handle('remove-printer', (event, printerId) => {
  printerPool = printerPool.filter(p => p.id !== printerId);
  savePrinterPool();
  return printerPool;
});

ipcMain.handle('update-printer', (event, printer) => {
  const idx = printerPool.findIndex(p => p.id === printer.id);
  if (idx > -1) {
    printerPool[idx] = { ...printerPool[idx], ...printer };
    savePrinterPool();
  }
  return printerPool;
});

ipcMain.handle('reorder-printers', (event, newOrder) => {
  printerPool = newOrder;
  savePrinterPool();
  return printerPool;
});

ipcMain.handle('toggle-printer', (event, printerId) => {
  const p = printerPool.find(p => p.id === printerId);
  if (p) {
    p.enabled = !p.enabled;
    savePrinterPool();
  }
  return printerPool;
});

function updatePrinterStatus(printerId, status, currentJob) {
  const p = printerPool.find(p => p.id === printerId);
  if (p) {
    p.status = status;
    p.currentJob = currentJob;
    if (status === 'online' && currentJob === null) p.jobCount = (p.jobCount || 0) + 1;
  }
  mainWindow?.webContents.send('printers-updated', printerPool);
}

// ── Queue State ────────────────────────────────────────────────────────────────

function getQueueState() {
  return {
    queued: jobQueue.filter(j => j.status === 'queued'),
    processing: jobQueue.filter(j => j.status === 'processing'),
    awaiting: pendingDialogueJobs.length,
    history: jobHistory
  };
}

ipcMain.handle('get-queue-state', () => getQueueState());
ipcMain.handle('clear-history', () => {
  jobHistory = [];
  return getQueueState();
});

ipcMain.handle('retry-job', (event, jobId) => {
  const job = jobHistory.find(j => j.id === jobId && j.status === 'error');
  if (job && job.pendingPath && fs.existsSync(job.pendingPath)) {
    job.status = 'queued';
    job.error = null;
    jobHistory = jobHistory.filter(j => j.id !== jobId);
    jobQueue.push(job);
    processQueue();
  }
  return getQueueState();
});

ipcMain.handle('get-folder-counts', () => {
  const count = (folder) => {
    if (!folder || !fs.existsSync(folder)) return 0;
    try {
      return fs.readdirSync(folder).filter(f => !f.startsWith('.')).length;
    } catch { return 0; }
  };
  return {
    in: count(config.inFolder),
    pending: count(config.pendingFolder),
    printed: count(config.printedFolder),
    stash: count(config.stashFolder)
  };
});

ipcMain.handle('toggle-watcher', () => {
  if (watcher) {
    stopWatcher();
    return false;
  } else {
    startWatcher();
    return true;
  }
});
