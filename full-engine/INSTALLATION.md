# 🚀 How to Run & Install PREV Player

Complete step-by-step guide to get PREV Player running on your computer and installing it on all devices.

---

## 🖥️ Step 1: Setup on Your Computer

### Prerequisites
- **Node.js** (v16 or higher) - [Download here](https://nodejs.org/)
- **Git** (optional, but recommended) - [Download here](https://git-scm.com/)
- **Code Editor** (VS Code recommended) - [Download here](https://code.visualstudio.com/)

### Verify Node.js Installation
Open terminal/command prompt and type:
```bash
node --version
npm --version
```

Should show versions like `v18.0.0` and `9.0.0`

---

## 📦 Step 2: Download & Setup Project

### Option A: Using Git (Recommended)
```bash
git clone https://github.com/Arouzefst1/Video-player.git
cd Video-player
npm install
```

### Option B: Direct Download
1. Visit: https://github.com/Arouzefst1/Video-player
2. Click **"Code"** → **"Download ZIP"**
3. Extract the ZIP file
4. Open terminal in the extracted folder
5. Run: `npm install`

### Option C: Folder Navigation
```bash
# Navigate to your project folder
cd "path/to/Video-player"

# Install dependencies
npm install
```

---

## ⚙️ Step 3: Start the Development Server

### On Windows
```bash
npm run dev
```

### On Mac/Linux
```bash
npm run dev
```

**Wait for output like:**
```
  ➜  Local:   http://localhost:3001/
  ➜  Network: http://192.168.0.111:3001/
```

✅ **Server is running!**

---

## 🌐 Step 4: Open in Browser

### Local (Same Computer)
Open your browser and visit:
```
http://localhost:3001
```

### Network (Other Devices on Same WiFi)
Find your computer's IP address:

**Windows:**
```bash
ipconfig
```
Look for "IPv4 Address" (usually `192.168.x.x`)

**Mac/Linux:**
```bash
ifconfig
```
Look for `inet` address

Then on your phone/tablet, visit:
```
http://192.168.0.111:3001
```
(Replace `192.168.0.111` with your actual IP)

---

## 📱 Step 5: Install as App

### On Android (Chrome/Edge/Firefox)
1. Open browser on phone
2. Visit: `http://192.168.0.111:3001`
3. Tap **menu button** (⋮) → **"Install app"**
4. Tap **"Install"**
5. ✅ App installed on home screen!

### On Windows Desktop (Chrome/Edge)
1. Open browser on your computer
2. Visit: `http://localhost:3001`
3. Click **install icon** in address bar (⬇️)
4. Click **"Install"**
5. ✅ App in Start Menu & Taskbar!

### On Mac (Chrome/Safari)
**Chrome:**
1. Visit: `http://localhost:3001`
2. Click **menu** (⋮) → **"Install app"**
3. Click **"Install"**

**Safari:**
1. Visit: `http://localhost:3001`
2. Click **Share button**
3. Select **"Add to Dock"**
4. ✅ App in dock!

### On Linux (Chrome/Chromium)
1. Visit: `http://localhost:3001`
2. Click **install icon** in address bar
3. Click **"Install"**
4. ✅ App appears in applications menu!

### On iPad/iPhone (Safari only)
1. Open Safari
2. Visit: `http://192.168.0.111:3001`
3. Tap **Share button** (arrow up)
4. Select **"Add to Home Screen"**
5. Name: **"PREV Player"**
6. Tap **"Add"**
7. ✅ App on home screen!

---

## ✨ Features After Installation

✅ **Offline Mode** - Works without internet  
✅ **Full Screen** - Dedicated app window  
✅ **Auto-Update** - Updates every 5 minutes when online  
✅ **No Browser Bar** - Pure app experience  
✅ **Install Multiple Times** - Works on all your devices  

---

## 📺 Using the App

### Load Videos
1. **Drag & Drop**: Drag video files into the player
2. **Browse**: Click **"Select Videos"** button
3. **Multiple Videos**: Build a playlist

### Basic Controls
- **Tap/Click video** → Play/Pause
- **Double-tap** → Fullscreen
- **Hold 500ms** → 2x speed
- **Click time** → Toggle remaining time

### Keyboard Shortcuts (Desktop)
- **K** - Play/Pause
- **L** - Forward 10s
- **J** - Rewind 10s
- **F** - Fullscreen
- **M** - Mute
- **C** - Subtitles

### Advanced Features
- **Playlists**: Add multiple videos
- **Subtitles**: Drag VTT/SRT files
- **Playback Speed**: 0.25x to 2x
- **Volume Control**: Click volume icon

---

## 🔄 Auto-Update Feature

**How it works:**
1. You make code changes
2. Dev server reloads (2-3 seconds)
3. App detects update (within 5 minutes)
4. **Auto-reloads** with new version
5. No user action needed!

**To trigger immediate update:**
- Close app completely
- Reopen app
- Pull down to refresh

---

## 🔍 Troubleshooting

### "Server not found" or "Cannot connect"
**Problem:** Browser can't find the server

**Fix:**
1. Make sure terminal still shows `npm run dev` running
2. Check IP address is correct
3. Make sure devices are on same WiFi
4. Restart server: `Ctrl+C` then `npm run dev`

### "Install button not showing"
**Problem:** Can't find install option

**Fix:**
1. **Refresh page**: Ctrl+Shift+R (or Cmd+Shift+R on Mac)
2. **Disable ad-blockers**: They block install prompts
3. **Clear cache**: DevTools → Clear storage
4. **Try incognito mode**: Open in private browser
5. **Use Chrome/Edge**: Best PWA support

### "Can't play videos offline"
**Problem:** Videos need internet to play

**Fix:**
- **Load video online first** (gets cached)
- **Once cached**, plays offline
- Close app and reopen to test offline

### "App keeps asking for permission"
**Problem:** Browser prompts keep appearing

**Fix:**
- Click "Always allow"
- Or use different browser
- Safari works without permissions

### "Port 3001 already in use"
**Problem:** Another app using the port

**Fix:**
```bash
# Kill process on port 3001 (Windows)
netstat -ano | findstr :3001
taskkill /PID <PID> /F

# Or Mac/Linux
lsof -i :3001
kill -9 <PID>

# Then restart
npm run dev
```

---

## 🚀 Advanced: Build for Production

When ready to deploy permanently:

```bash
npm run build
```

Creates `/dist` folder with optimized app.

**Deploy options:**
- **Vercel**: `vercel deploy`
- **Netlify**: `netlify deploy`
- **GitHub Pages**: Static hosting
- **Your Server**: Copy `/dist` to web root

**Important:** Use HTTPS in production (except localhost)

---

## 💡 Pro Tips

### Tip 1: Multiple Devices
Install on multiple devices at once:
- PC: http://localhost:3001 → Install
- Phone: http://192.168.0.111:3001 → Install
- Tablet: http://192.168.0.111:3001 → Install

All auto-update together!

### Tip 2: Share Videos
After installing app:
- Place videos in accessible folder
- Share folder path with friends
- They can load same videos

### Tip 3: Offline Prep
1. Load videos while online (cached)
2. Go offline
3. Videos play offline
4. Share locally with nearby devices

### Tip 4: Development Workflow
```bash
npm run dev        # Start development
# Make code changes
# App hot-reloads automatically
# Test in browser
Ctrl+C            # Stop when done
npm run build     # Create production build
```

---

## 📊 System Requirements

| Device | Requirement | Notes |
|--------|-------------|-------|
| **Windows** | Windows 7+ | Chrome/Edge |
| **Mac** | macOS 10.12+ | Safari/Chrome |
| **Linux** | Any distro | Chrome/Chromium |
| **Android** | Android 5.0+ | Chrome/Edge/Firefox |
| **iOS** | iOS 12.2+ | Safari only |
| **iPad** | iPadOS 12.2+ | Safari only |

**Storage Needed:** 50-100 MB for app + cache

---

## 🎯 Quick Checklist

- [ ] Node.js installed (`node --version`)
- [ ] Project downloaded and extracted
- [ ] Dependencies installed (`npm install`)
- [ ] Dev server running (`npm run dev`)
- [ ] Browser can access `http://localhost:3001`
- [ ] Install button visible
- [ ] App installed successfully
- [ ] Can add/play videos
- [ ] Offline mode tested

---

## 📞 Getting Help

### If something doesn't work:
1. **Check console**: Press F12 → Console tab
2. **Look for errors**: Red messages in console
3. **Restart server**: Ctrl+C, then `npm run dev`
4. **Clear cache**: DevTools → Application → Clear all
5. **Try different browser**: Chrome works best

### Common error messages:
- **"Cannot find module"** → Run `npm install`
- **"EADDRINUSE"** → Port in use, see troubleshooting above
- **"Cannot GET /"** → Server not running
- **"CORS error"** → Clear browser cache

---

## 🎉 You're Ready!

Your PREV Player is ready to run and install! 

**Next steps:**
1. Run `npm run dev` in terminal
2. Open `http://localhost:3001` in browser
3. Click install button
4. Enjoy your video player!

---

## 📚 Additional Resources

- **PWA Setup Guide**: See `PWA_SETUP.md`
- **Full Documentation**: See `PWA_COMPLETE.md`
- **Quick Reference**: See `QUICK_START.md`
- **GitHub**: https://github.com/Arouzefst1/Video-player
- **Node.js Docs**: https://nodejs.org/docs/

---

**Happy watching! 🎬**
