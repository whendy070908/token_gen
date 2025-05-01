const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const config = require('./config');
const fetch = require('node-fetch');

let mainWindow;
let currentBrowser = null;
let currentEmailPage = null;
let currentDiscordPage = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

function log(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  let prefix = '';
  
  switch(type) {
    case 'error':
      prefix = '[오류]';
      break;
    case 'success':
      prefix = '[성공]';
      break;
    case 'info':
      prefix = '[정보]';
      break;
    case 'warning':
      prefix = '[경고]';
      break;
  }
  
  const logMessage = `${prefix} ${message}`;
  console.log(Buffer.from(logMessage, 'utf8').toString('utf8'));
  
  if (mainWindow) {
    mainWindow.webContents.send('update-log', { message, type });
  }
  
  fs.appendFileSync('discord_account_creator.log', `[${timestamp}] ${logMessage}\n`, { encoding: 'utf8' });
}

function generateRandomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}


async function getRandomProxy() {
  try {
    const proxies = fs.readFileSync('data/proxies.txt', 'utf-8').split('\n').filter(line => line.trim());
    if (proxies.length === 0) {
      throw new Error('프록시 파일이 비어있습니다');
    }
    return proxies[Math.floor(Math.random() * proxies.length)].trim();
  } catch (error) {
    log(`프록시 로딩 실패: ${error.message}`, 'error');
    return null;
  }
}

const createCaptchaTask = async (capmonsterKey, sitekey, websiteURL, proxy = null) => {
  const taskData = {
    clientKey: capmonsterKey,
    task: {
      type: 'HCaptchaTaskProxyless',
      websiteURL,
      websiteKey: sitekey
    }
  };

  // 프록시 설정이 있는 경우 taskData에 추가
  if (proxy) {
    taskData.task.type = 'HCaptchaTask';
    const [proxyHost, proxyPort, proxyUser, proxyPass] = proxy.split(':');
    taskData.task.proxyType = 'http';
    taskData.task.proxyAddress = proxyHost;
    taskData.task.proxyPort = parseInt(proxyPort);
    if (proxyUser && proxyPass) {
      taskData.task.proxyLogin = proxyUser;
      taskData.task.proxyPassword = proxyPass;
    }
  }

  const response = await fetch('https://api.capmonster.cloud/createTask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(taskData)
  });
  const data = await response.json();
  if (!data.taskId) throw new Error('태스크 생성 실패');
  return data.taskId;
};

const getCaptchaResult = async (capmonsterKey, taskId) => {
  for (let i = 0; i < 30; i++) {
    await delay(2000);
    const response = await fetch('https://api.capmonster.cloud/getTaskResult', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: capmonsterKey, taskId })
    });
    const data = await response.json();
    if (data.status === 'ready') {
      return data.solution.gRecaptchaResponse;
    }
    log(`캡챠 해결 대기 중... (${i + 1}/30)`, 'info');
  }
  throw new Error('캡챠 해결 실패');
};

const solveCaptcha = async (page, config) => {
  log('캡챠 로딩 대기 중...', 'info');
  const captchaFrame = await page.waitForSelector('iframe[title*="challenge"]', { timeout: 30000 });
  if (!captchaFrame) return false;

  // 사용자에게 수동/자동 선택 요청
  if (mainWindow) {
    mainWindow.webContents.send('captcha-choice');
    const choice = await new Promise(resolve => {
      ipcMain.once('captcha-mode', (event, mode) => {
        resolve(mode);
      });
    });
    
    if (choice === 'manual') {
      log('수동 캡챠 모드. 캡챠를 직접 해결해주세요...', 'info');
      return new Promise(resolve => {
        ipcMain.once('captcha-completed', () => {
          log('수동 캡챠 완료 확인', 'success');
          resolve(true);
        });
      });
    }
  }

  const frame = await captchaFrame.contentFrame();
  await delay(2000);

  let isDragCaptcha = true;
  let retryCount = 0;
  const maxRetries = 5;

  while (isDragCaptcha && retryCount < maxRetries) {
    try {
      await delay(1000);
      
      await frame.waitForSelector('.prompt-text, .prompt-label, h2.prompt', { timeout: 5000 });
      
      const challengeType = await frame.evaluate(() => {
        const promptElement = document.querySelector('.prompt-text, .prompt-label, h2.prompt');
        return promptElement ? promptElement.textContent : '';
      });

      if (challengeType && challengeType.toLowerCase().includes('drag')) {
        log('드래그 캡챠 감지됨, 새로고침 시도...', 'warning');
        try {
          const refreshButton = await frame.waitForSelector(
            'button[aria-label*="refresh"], button[title*="refresh"], .refresh-button, .refresh',
            { timeout: 2000 }
          );
          
          if (refreshButton) {
            await refreshButton.evaluate(button => button.click());
          } else {

            await frame.evaluate(() => {
              window.location.reload();
            });
          }
          await delay(2000);
        } catch (refreshError) {
          log(`새로고침 시도 실패, 프레임 리로드...`, 'warning');
          await captchaFrame.evaluate(frame => {
            frame.src = frame.src;
          });
          await delay(2000);
        }
        retryCount++;
      } else {
        isDragCaptcha = false;
      }
    } catch (error) {
      log(`캡챠 타입 확인 중 오류: ${error.message}`, 'error');
      await delay(2000);
      retryCount++;
    }
  }

  await delay(2000);
  
  try {
    await frame.waitForFunction(() => {
      const iframe = document.querySelector('iframe[src*="hcaptcha"]');
      return iframe && iframe.contentDocument && iframe.contentDocument.readyState === 'complete';
    }, { timeout: 10000 });

    await frame.waitForFunction(() => {
      const sitekey = document.querySelector('input[name="sitekey"]');
      const challenge = document.querySelector('input[name="h-captcha-response"]');
      return sitekey && challenge;
    }, { timeout: 10000 });
    
    log('캡챠 로드 완료, 해결 시도 중...', 'info');
    const siteKey = await frame.$eval('input[name="sitekey"]', el => el.value);
    
    try {
      let proxy = null;
      if (config.proxyless === "off") {
        proxy = await getRandomProxy();
      }
      
      const taskId = await createCaptchaTask(config.capmonsterKey, siteKey, 'https://discord.com/register', proxy);
      log('캡챠 해결 중...', 'info');
      const solvedToken = await getCaptchaResult(config.capmonsterKey, taskId);
      log('캡챠 해결 완료', 'success');
      
      await frame.evaluate((token) => {
        document.querySelector('[name="h-captcha-response"]').value = token;
        document.querySelector('[name="g-recaptcha-response"]').value = token;
      }, solvedToken);
      
      await frame.click('button[type="submit"]');
      log('캡챠 제출 완료', 'success');
      return true;
    } catch (error) {
      log(`캡챠 처리 중 오류 발생: ${error.message}`, 'error');
      return false;
    }
  } catch (error) {
    log(`캡챠 요소 대기 중 오류: ${error.message}`, 'error');
    return false;
  }
};

ipcMain.on('manual-captcha-complete', (event) => {
  ipcMain.emit('captcha-completed');
});

async function createDiscordAccount(config) {
  const { usernamePrefix, nicknamePrefix, passwordPrefix, accountCount } = config;
  let successCount = 0;
  let currentAccount = 1;

  while (successCount < accountCount) {
    const randomSuffix = generateRandomString(5);
    const username = usernamePrefix + randomSuffix;
    const nickname = nicknamePrefix + randomSuffix;
    const password = passwordPrefix + randomSuffix;
    
    log(`계정 생성 중 (${currentAccount}/${accountCount})...`, 'info');
    log('브라우저 시작 중...', 'info');
    currentBrowser = await puppeteer.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1024,768',
        '--disable-notifications'
      ],
      defaultViewport: {
        width: 1024,
        height: 768
      }
    });

    let success = false;
    let retryCount = 0;
    const maxRetries = 5;

    while (!success && retryCount < maxRetries) {
      try {
        currentEmailPage = await currentBrowser.newPage();
        await currentEmailPage.setViewport({ width: 1024, height: 768 });
        log('일회용 이메일 페이지로 이동 중...', 'info');
        await currentEmailPage.goto('https://temp-mail.org/', { 
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        
        let email = null;
        let emailRetries = 0;
        const maxEmailRetries = 30;
        
        while (emailRetries < maxEmailRetries) {
          try {
            email = await currentEmailPage.$eval('#mail', el => el.value);
            if (email && !email.toLowerCase().includes("loading")) {
              log(`이메일 주소 로드 성공: ${email}`, 'success');
              break;
            }
            log(`이메일 주소 로드 중... (${emailRetries + 1}/${maxEmailRetries})`, 'info');
            await delay(2000);
            emailRetries++;
          } catch (error) {
            log(`이메일 주소 로드 실패: ${error.message}`, 'error');
            await delay(2000);
            emailRetries++;
          }
        }
        
        if (!email) {
          throw new Error('이메일 주소를 불러오지 못했습니다.');
        }
        log(`생성된 이메일 주소: ${email}`, 'info');

        currentDiscordPage = await currentBrowser.newPage();
        await currentDiscordPage.setViewport({ width: 1024, height: 768 });
        log('Discord 회원가입 페이지로 이동 중...', 'info');
        await currentDiscordPage.goto('https://discord.com/register', { 
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        
        await currentDiscordPage.waitForSelector('input[type="email"]');
        await currentDiscordPage.type('input[type="email"]', email);
        
        await currentDiscordPage.waitForSelector('input[name="username"]');
        await currentDiscordPage.type('input[name="username"]', username);
        
        await currentDiscordPage.waitForSelector('input[name="global_name"]');
        await currentDiscordPage.type('input[name="global_name"]', nickname);
        
        await currentDiscordPage.waitForSelector('input[type="password"]');
        await currentDiscordPage.type('input[type="password"]', password);
        
        log('생년월일을 수동으로 선택해주세요. 완료 후 계속하기 버튼을 클릭해주세요.', 'info');
        
        if (mainWindow) {
          mainWindow.webContents.send('request-continue');
        }
        
        await new Promise(resolve => {
          ipcMain.once('continue-creation', () => {
            resolve();
          });
        });
        
        await currentDiscordPage.waitForSelector('input[type="checkbox"]');
        await currentDiscordPage.click('input[type="checkbox"]');
        
        await currentDiscordPage.waitForSelector('button[type="submit"]');
        await currentDiscordPage.click('button[type="submit"]');

        let captchaSuccess = false;
        let captchaRetryCount = 0;
        const maxCaptchaRetries = 10;

        while (!captchaSuccess && captchaRetryCount < maxCaptchaRetries) {
          try {
            captchaSuccess = await solveCaptcha(currentDiscordPage, config);
            if (!captchaSuccess) {
              captchaRetryCount++;
              log(`캡챠 처리 실패, 다시 시도 중... (${captchaRetryCount}/${maxCaptchaRetries})`, 'error');
              await delay(5000);
            }
          } catch (error) {
            captchaRetryCount++;
            log(`캡챠 처리 중 오류 발생: ${error.message}, 다시 시도 중... (${captchaRetryCount}/${maxCaptchaRetries})`, 'error');
            await delay(5000);
          }
        }

        if (!captchaSuccess) {
          throw new Error('캡챠 처리 최대 시도 횟수 초과');
        }

        let verifyLink = null;
        const startTime = Date.now();
        while (Date.now() - startTime < 120000 && !verifyLink) {
          await currentEmailPage.reload();
          const emails = await currentEmailPage.$$('.inbox-dataList .inbox-dataList-item');
          for (const email of emails) {
            const sender = await email.$eval('.inbox-sender', el => el.textContent);
            const subject = await email.$eval('.inbox-subject', el => el.textContent);
            if (sender.includes('Discord') && subject.includes('Verify')) {
              await email.click();
              await delay(2000);
              verifyLink = await currentEmailPage.$eval('a[href*="discord.com/verify"]', el => el.href);
              break;
            }
          }
          if (!verifyLink) {
            await delay(10000);
          }
        }
        
        if (verifyLink) {
          await currentDiscordPage.goto(verifyLink);
          log('이메일 인증 완료', 'success');
          
          const token = await currentDiscordPage.evaluate(() => {
            return localStorage.getItem('token');
          });
          
          if (token) {
            const accountInfo = `${email}:${password}:${token}\n`;
            fs.appendFileSync('discord_accounts.txt', accountInfo, { encoding: 'utf8' });
            log('계정 정보 저장 완료', 'success');
            
            success = true;
            successCount++;
            currentAccount++;
            log(`계정 생성 완료 (${successCount}/${accountCount})`, 'success');
            
            await currentBrowser.close();
            currentBrowser = null;
            currentEmailPage = null;
            currentDiscordPage = null;
            
            if (successCount < accountCount) {
              log('다음 계정 생성을 위해 5초 대기 중...', 'info');
              await delay(5000);
            }
          } else {
            throw new Error('토큰을 추출하지 못했습니다');
          }
        } else {
          throw new Error('인증 메일을 찾지 못함');
        }
      } catch (error) {
        retryCount++;
        log(`계정 생성 시도 ${retryCount}/${maxRetries} 실패: ${error.message}`, 'error');
        if (retryCount < maxRetries) {
          log('5초 후 다시 시도합니다...', 'info');
          await delay(5000);
        }
      }
    }

    if (!success) {
      log('최대 시도 횟수를 초과했습니다. 브라우저를 닫으려면 수동으로 닫아주세요.', 'error');
      return false;
    }
  }

  return true;
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.on('start-creation', async (event, config) => {
  try {
    log('계정 생성 시작...', 'info');
    const success = await createDiscordAccount(config);
    event.reply('creation-finished', success);
  } catch (error) {
    log(`계정 생성 중 오류 발생: ${error.message}`, 'error');
    event.reply('creation-finished', false);
  }
});

ipcMain.on('log-update', (event, { message, type }) => {
  if (mainWindow) {
    mainWindow.webContents.send('update-log', { message, type });
  }
});

ipcMain.on('captcha-image', (event, imagePath) => {
  if (mainWindow) {
    mainWindow.webContents.send('show-captcha', imagePath);
  }
});

ipcMain.on('captcha-code', (event, code) => {
  if (mainWindow) {
    mainWindow.webContents.send('submit-captcha', code);
  }
});