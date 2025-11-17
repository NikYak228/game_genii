const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

(async () => {
  const port = 4321;
  const server = spawn(path.join(__dirname, 'node_modules/.bin/http-server'), ['.', '-p', String(port)], { cwd: __dirname });
  await new Promise((resolve, reject) => {
    const onData = data => {
      if (data.toString().includes('Available on')) resolve();
    };
    server.stdout.on('data', onData);
    server.stderr.on('data', data => process.stderr.write('SERVER: ' + data));
    server.on('error', reject);
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('console', msg => console.log('PAGE:', msg.text()));
  const url = `http://127.0.0.1:${port}/game.html`;
  await page.goto(url);

  await page.waitForSelector('#navBar .navbtn[data-nav="training"]');
  await page.click('#navBar .navbtn[data-nav="training"]');
  await page.waitForFunction(() => !!document.querySelector('#startTrain'));
  await page.click('#startTrain');
  await page.waitForTimeout(1500);

  const readPos = () => page.evaluate(() => {
    const dbg = window.__arenaDebug;
    if (!dbg) return null;
    return {
      x: dbg.player.position.x,
      z: dbg.player.position.z
    };
  });

  const before = await readPos();
  await page.keyboard.down('d');
  await page.waitForTimeout(1000);
  await page.keyboard.up('d');
  await page.waitForTimeout(500);
  const after = await readPos();
  await page.waitForTimeout(3000);
  const after2 = await readPos();

  console.log({ before, after, after2 });
  await browser.close();
  server.kill();
})();
