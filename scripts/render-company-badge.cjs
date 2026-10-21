// Authoring-only SVG/PNG export using Electron's renderer; not shipped as a runtime dependency.
// Run with the development Electron executable after changing the badge design.
const { app, BrowserWindow, nativeImage } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const directory = join(__dirname, 'assets/company-badge');
// This small embedded instance needs at most 120px at the PNG export scale.
const mark = nativeImage.createFromPath(join(__dirname, '../apps/client/assets/rufajx-mark.png')).resize({ width: 192, quality: 'best' }).toPNG().toString('base64');
const logo = `<image href="data:image/png;base64,${mark}" x="6" y="4" width="20" height="20" filter="url(#white)"/>`;
const filter = '<defs><filter id="white" color-interpolation-filters="sRGB"><feFlood flood-color="white"/><feComposite in2="SourceAlpha" operator="in"/></filter></defs>';
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="28" viewBox="0 0 180 28" role="img" aria-label="如发机械有限公司">${filter}<rect width="180" height="28" rx="4" fill="#35383d"/><path d="M32 4v20" stroke="#62666b" stroke-width="1"/>${logo}<text x="106" y="14.5" dominant-baseline="central" text-anchor="middle" fill="#fff" font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif" font-size="13">如发机械有限公司</text></svg>\n`;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">${filter}<rect width="48" height="48" rx="10" fill="#35383d"/><image href="data:image/png;base64,${mark}" x="9" y="9" width="30" height="30" filter="url(#white)"/></svg>\n`;
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1080, height: 168, webPreferences: { sandbox: true, contextIsolation: true } });
  try {
    await window.loadURL('data:text/html,<html><body></body></html>');
    const png = await window.webContents.executeJavaScript(`(async()=>{const img=new Image(); img.src=${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)}; await img.decode(); const c=document.createElement('canvas'); c.width=1080;c.height=168;c.getContext('2d').drawImage(img,0,0,1080,168);return c.toDataURL('image/png').split(',')[1]})()`);
    writeFileSync(join(directory, 'rufa-badge.svg'), svg);
    writeFileSync(join(directory, 'icon.svg'), icon);
    writeFileSync(join(directory, 'rufa-badge.png'), Buffer.from(png, 'base64'));
    const preview = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="260" viewBox="0 0 640 260"><rect width="640" height="260" rx="12" fill="#202123"/><rect x="72" y="30" width="496" height="200" rx="10" fill="#fafafa" stroke="#dedede"/><text x="104" y="72" font-family="Microsoft YaHei, sans-serif" font-size="19" fill="#27292d">项目方案</text><path d="M104 96h302M104 116h422M104 136h366" stroke="#e0e2e5" stroke-width="8" stroke-linecap="round"/><image href="data:image/png;base64,${png}" x="104" y="174" width="180" height="28"/></svg>\n`;
    writeFileSync(join(directory, 'preview.svg'), preview);
    console.log(JSON.stringify({ badge: join(directory, 'rufa-badge.png'), width: 1080, height: 168 }));
  } finally { window.destroy(); app.quit(); }
}).catch(error => { console.error(error); app.exit(1); });
