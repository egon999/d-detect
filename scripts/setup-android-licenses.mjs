import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const licDir = resolve(process.env.USERPROFILE || 'C:\\Users\\ayush', 'AppData/Local/Android/Sdk/licenses');
mkdirSync(licDir, { recursive: true });

const licenses = {
  'android-sdk-license': `8933bad161af4178b1185d1a37fbf41ea5269c55
d56f5187479451eabf01fb78af6dfcb131a6481e
24333f8a63b6825ea9c5514f83c2829b004d1fee
24333f8a63cbd82421b01a49f3ea7371a8f98a4d`,
  'android-sdk-preview-license': `84831b9409646a532e30349323498849486e44ac
84831b9409646a918e30573bab4c9c91346d8abd`,
  'android-googletv-license': '601085b2e2f797dd3a70c4a8b008f226242a088c',
  'android-sdk-arm-dbt-license': '859f317696f67ef3d7f30a50a5560e7834b43903',
  'google-gdk-license': '33b6a2b649079429bd69c15f4525a242fce83822',
  'mips-android-sysimage-license': 'e9acab587f1749a606fb33b6138d95ed24305ca2',
};

for (const [name, content] of Object.entries(licenses)) {
  writeFileSync(resolve(licDir, name), content + '\n', 'ascii');
}

console.log('Successfully written Android licenses to', licDir);
