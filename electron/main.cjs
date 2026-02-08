const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

// FIX: Disable sandbox on Linux to prevent startup crashes (common in Kiosk/Fedora)
if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-gpu-sandbox');
}

function createWindow() {
    const win = new BrowserWindow({
        fullscreen: true,
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            devTools: true,
            sandbox: false,
            backgroundThrottling: false,
            preload: path.join(__dirname, 'preload.cjs') // Register Preload
        }
    });

    // ... (Window setup kept same)
    win.setMenu(null);
    win.removeMenu();

    const isDev = !app.isPackaged;
    if (isDev) {
        win.loadURL('http://localhost:5173');
        console.log('Loading http://localhost:5173');
    } else {
        win.loadFile(path.join(__dirname, '../dist/index.html'));
    }
}

app.whenReady().then(() => {
    // IPC Handler for System Info
    ipcMain.handle('get-system-info', () => {
        // ... (Network logic same) ...
        const nets = os.networkInterfaces();
        let mac = "Unknown";
        let localIp = "Unknown";
        // ... (Loop logic same) ...
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    if (net.mac && net.mac !== '00:00:00:00:00:00') {
                        mac = net.mac;
                        localIp = net.address;
                    }
                }
            }
        }

        // Display Info (Electron Main Process)
        const { screen } = require('electron');
        const primaryDisplay = screen.getPrimaryDisplay();
        const displayInfo = {
            width: primaryDisplay.size.width,
            height: primaryDisplay.size.height,
            scale: primaryDisplay.scaleFactor,
            touch: primaryDisplay.touchSupport === 'available'
        };

        // Linux Distro Detection (Specific Request)
        let distro = "Unknown";
        if (os.platform() === 'linux') {
            try {
                const fs = require('fs');
                const releaseData = fs.readFileSync('/etc/os-release', 'utf8');
                const match = releaseData.match(/PRETTY_NAME="([^"]+)"/);
                if (match) distro = match[1]; // e.g. "Fedora Linux 39 (Workstation Edition)"
            } catch (e) {
                distro = "Linux (Generic)";
            }
        }

        return {
            hostname: os.hostname(),
            platform: os.platform(),
            release: os.release(),
            type: os.type(),
            distro: distro, // NEW: Specific Distro Name
            arch: os.arch(),
            cpus: os.cpus().map(cpu => cpu.model)[0],
            totalmem: os.totalmem(),
            userInfo: os.userInfo().username,
            mac: mac,
            localIp: localIp,
            uptime: os.uptime(),
            loadAvg: os.loadavg(),
            display: {
                width: primaryDisplay.size.width,
                height: primaryDisplay.size.height,
                scale: primaryDisplay.scaleFactor,
                touch: primaryDisplay.touchSupport === 'available'
            }
        };
    });

    createWindow();

    // Check permission (modern Electron)
    const { session } = require('electron');
    session.defaultSession.setPermissionCheckHandler((webContents, permission, origin) => {
        if (permission === 'audioCapture' || permission === 'media' || permission === 'geolocation') {
            return true;
        }
        return false;
    });

    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'audioCapture' || permission === 'media' || permission === 'geolocation') {
            return callback(true);
        }
        callback(false);
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
