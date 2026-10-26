// امضای ad-hoc برای مک (بدون حساب توسعه‌دهنده) تا برنامه روی M1 اجرا شود
const path = require('path');
const { execFileSync } = require('child_process');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const appPath = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app');
  console.log('ad-hoc signing', appPath);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
