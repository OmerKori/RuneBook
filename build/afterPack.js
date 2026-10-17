// Puts RuneBook's icon (and name) into RuneBook.exe after packing.
// electron-builder's own way needs Wine when building on Linux; resedit does it in plain JS.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');
const PE = require('pe-library');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const exe = PE.NtExecutable.from(fs.readFileSync(exePath));
  const res = PE.NtExecutableResource.from(exe);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(__dirname, 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  for (const g of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, ico.icons.map((i) => i.data));
  }
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (vi) {
    const version = context.packager.appInfo.version;
    for (const lang of vi.getAllLanguagesForStringValues()) {
      vi.setStringValues(lang, {
        FileDescription: 'RuneBook', ProductName: 'RuneBook', InternalName: 'RuneBook',
        OriginalFilename: 'RuneBook.exe', CompanyName: 'RuneBook', LegalCopyright: 'RuneBook', FileVersion: version, ProductVersion: version,
      });
    }
    vi.outputToResourceEntries(res.entries);
  }
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
};
