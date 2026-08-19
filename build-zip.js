import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist-v3');

if (!fs.existsSync(distDir)) {
    console.error('❌ dist-v3 資料夾不存在，請先執行 npm run build');
    process.exit(1);
}

function addDirectoryToZip(zip, dirPath, zipFolderPath, filterFn = null) {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const relativeZipPath = zipFolderPath ? `${zipFolderPath}/${item}` : item;
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            addDirectoryToZip(zip, fullPath, relativeZipPath, filterFn);
        } else {
            if (filterFn && !filterFn(relativeZipPath)) {
                continue; // 跳過被過濾的素材
            }
            if (relativeZipPath === 'manifest.json') {
                const manifestObj = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
                delete manifestObj.key;
                zip.file(relativeZipPath, JSON.stringify(manifestObj, null, 2));
            } else {
                zip.file(relativeZipPath, fs.readFileSync(fullPath));
            }
        }
    }
}

async function packageZip(zipName, filterFn = null) {
    const zip = new JSZip();
    addDirectoryToZip(zip, distDir, '', filterFn);

    const content = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
    });

    const outputPath = path.join(rootDir, zipName);
    fs.writeFileSync(outputPath, content);
    const sizeMB = (content.length / (1024 * 1024)).toFixed(2);
    console.log(`✅ 成功打包: ${zipName} (${sizeMB} MB)`);
}

async function run() {
    console.log('🚀 開始打包商店上架 Zip 檔案...');

    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf-8'));
    const version = pkg.version || '3.0.1';

    // 1. 打包完整版 (包含全部主題立繪與動畫)
    await packageZip(`Manga_Translator_V${version}_Store_Package.zip`);

    // 2. 打包精選輕量版 (精選熱門立繪與跑步動畫，體積約 2.7MB)
    await packageZip(`Manga_Translator_V${version}_Store_Package_Light.zip`, (relPath) => {
        // 跑步素材精選 01, 02, 03, 06, 07, 08, 09, 30
        if (relPath.startsWith('assets/running/')) {
            const fileName = path.basename(relPath);
            return /^(01_|02_|03_|06_|07_|08_|09_|30_)/.test(fileName);
        }
        // 立繪素材精選熱門
        if (relPath.startsWith('assets/standing/')) {
            const fileName = path.basename(relPath);
            return fileName.startsWith('admire') || fileName.startsWith('agnes') || fileName.startsWith('air') || fileName.startsWith('special') || fileName.startsWith('tokai') || fileName.startsWith('gold');
        }
        if (relPath.startsWith('assets/standing_priconne/')) {
            const fileName = path.basename(relPath);
            return fileName.startsWith('pecorine') || fileName.startsWith('kokkoro') || fileName.startsWith('kyaru');
        }
        return true;
    });

    // 3. 打包極致純淨超輕量版 (過濾所有非必要大型立繪，僅保留核心翻譯與基本 UI，體積 < 600KB)
    await packageZip(`Manga_Translator_V${version}_Store_Package_UltraLight.zip`, (relPath) => {
        if (relPath.startsWith('assets/standing/') || relPath.startsWith('assets/standing_priconne/') || relPath.startsWith('assets/running/')) {
            return false;
        }
        return true;
    });

    console.log('🎉 所有 ZIP 商店包 (完整版 / 精選輕量版 / 極致超輕量版) 已成功寫入專案根目錄！');
}

run().catch(err => {
    console.error('❌ 打包過程失敗:', err);
    process.exit(1);
});
