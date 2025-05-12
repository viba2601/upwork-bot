const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// add the stealth plugin
puppeteer.use(StealthPlugin());
require('dotenv').config();

function getRndm(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}


function getLatestExcelFile(dir) {
    const files = fs.readdirSync(dir)
        .filter(file => file.endsWith('.xlsx'))
        .map(file => ({
            file,
            time: fs.statSync(path.join(dir, file)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time); // newest first

    return files.length > 0 ? path.join(dir, files[0].file) : null;
}

function readFilters() {
    const content = fs.readFileSync('filters.txt', 'utf-8');
    const filters = {};
    content.split('\n').forEach(line => {
        const [key, valueRaw] = line.split('=');
        if (!key) return;
        const keyTrimmed = key.trim();
        const value = valueRaw?.trim();

        if (value === '') {
            filters[keyTrimmed] = null; // empty value = no constraint
        } else if (value.includes(',')) {
            filters[keyTrimmed] = value.split(',').map(v => v.trim().toLowerCase());
        } else if (!isNaN(value)) {
            filters[keyTrimmed] = parseFloat(value);
        } else {
            filters[keyTrimmed] = value.toLowerCase();
        }
    });
    return filters;
}

async function isNewClient(page) {
    try {
        const joinDateText = await page.$eval('li[data-qa="client-contract-date"] small', el => el.innerText.trim());
        const match = joinDateText.match(/Member since (.+)/i);
        if (!match) return { joinedRecently: false, memberSince: null };

        const memberSince = match[1].trim();
        const joined = new Date(memberSince);
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

        return {
            joinedRecently: joined > oneMonthAgo,
            memberSince,
        };
    } catch (err) {
        console.log('⚠️ Join date not found');
        return { joinedRecently: false, memberSince: null };
    }
}


// async function getClientTotalSpent(page) {
//     try {
//         const spentText = await page.$eval('strong[data-qa="client-spend"]', el => el.innerText.trim());
//         const match = spentText.match(/\$([\d.,K]+)/);
//         if (!match) return 0;

//         let amountStr = match[1].replace(',', '');
//         if (amountStr.includes('K')) {
//             return parseFloat(amountStr.replace('K', '')) * 1000;
//         }
//         return parseFloat(amountStr);
//     } catch (err) {
//         console.log('⚠️ Total spent not found');
//         return 0;
//     }
// }

function parseTotalSpent(spentStr) {
    const cleanStr = spentStr.replace(/\+/g, '').trim();
    if (cleanStr.includes('K')) {
        return parseFloat(cleanStr.replace('$', '').replace('K', '')) * 1000;
    }
    if (cleanStr.includes('M')) {
        return parseFloat(cleanStr.replace('$', '').replace('M', '')) * 1_000_000;
    }
    return parseFloat(cleanStr.replace('$', '')) || 0;
}




async function getClientHireRate(page, jobUrl) {
    try {
        await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('li[data-qa="client-job-posting-stats"]', { timeout: 10000 });

        const hireRateText = await page.$eval('li[data-qa="client-job-posting-stats"] div', el => el.innerText.trim());
        const hireMatch = hireRateText.match(/(\d+)%\s*hire rate/);
        const hireRate = hireMatch ? parseInt(hireMatch[1]) : null;

        const { joinedRecently, memberSince } = await isNewClient(page);

        return { hireRate, joinedRecently, memberSince };
    } catch (err) {
        console.log(`⚠️ Failed to fetch client data for: ${jobUrl}`);
        return { hireRate: null, joinedRecently: false, memberSince: null };
    }
}

async function getClientActivityData(page) {
    try {
        const activityData = await page.$$eval('li.ca-item', items => {
            const data = { interviewing: 0, invitesSent: 0, hires: 0 };

            items.forEach(item => {
                const title = item.querySelector('.title')?.innerText.trim();
                const valueText = item.querySelector('.value')?.innerText.trim() || '0';
                const value = parseInt(valueText.replace(/[^\d]/g, '')) || 0;

                if (title.includes('Interviewing')) {
                    data.interviewing = value;
                } else if (title.includes('Invites sent')) {
                    data.invitesSent = value;
                } else if (title.includes('Hires')) {
                    data.hires = value;
                }
            });

            return data;
        });

        return activityData;
    } catch (err) {
        console.log('⚠️ Error parsing client activity block');
        return { interviewing: 0, invitesSent: 0, hires: 0 };
    }
}

async function getQualificationDetails(page) {
    try {
        const result = {
            preferredLanguage: [],
            preferredLocation: [],
            disqualified: false
        };

        const items = await page.$$('ul.qualification-items li');

        for (const li of items) {
            const labelEl = await li.$('strong');
            const labelText = labelEl ? (await (await labelEl.getProperty('innerText')).jsonValue()).trim() : '';

            const valueEl = await li.$('span:not(.icons)');
            const valueText = valueEl ? (await (await valueEl.getProperty('innerText')).jsonValue()).trim() : '';

            if (labelText.startsWith('Languages')) {
                result.preferredLanguage.push(valueText);
                const dangerIcon = await li.$('.text-danger');
                if (dangerIcon) result.disqualified = true;
            }

            if (labelText.startsWith('Location')) {
                result.preferredLocation.push(valueText);
                const dangerIcon = await li.$('.text-danger');
                if (dangerIcon) result.disqualified = true;
            }
        }

        return result;
    } catch (err) {
        console.log('⚠️ Error parsing qualifications:', err);
        return {
            preferredLanguage: [],
            preferredLocation: [],
            disqualified: false
        };
    }
}




async function extractAndCheckLinksFromExcel(page, filePath) {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet);

    const updatedData = [];

    for (const row of data) {
        const link = row.Link;
        if (!link) continue;

        const totalSpentRaw = row["Total Spent"];
        const totalSpent = parseTotalSpent(totalSpentRaw);
        const { hireRate, joinedRecently, memberSince } = await getClientHireRate(page, link);
        const { interviewing, invitesSent, hires } = await getClientActivityData(page);
        const {  preferredLanguage, preferredLocation, disqualified } = await getQualificationDetails(page);
        const filters = readFilters();

        // Apply the filtering conditions:
        // if (hireRate === 0 || hires === 0 || interviewing > 7 || invitesSent > 7) {
        //     console.log(`❌ Skipped: ${link} (hireRate: ${hireRate}, hires: ${hires}, interviewing: ${interviewing}, invites sent: ${invitesSent})`);
        //     continue; // Skip the current link
        // }

        // Status logic
        let status = "Appliable";
        if ((hireRate === 0 && !joinedRecently) || (totalSpent === 0 && !joinedRecently)) {
            status = "Unappliable - No Spend";
        }

        if(hires > 0 || interviewing > filters.interviewing || invitesSent > filters.invite_sent){
            status = "Unappliable - High Activity";
        }

        if (disqualified) {
            status = "Unappliable - No Preferred Language/Location";
        }
    

        // Append new values to the row
        row['Hire Rate'] = hireRate !== null ? `${hireRate}%` : 'N/A';
        row['Member Since'] = memberSince || 'N/A';
        row['Interviewing'] = interviewing || 'N/A';
        row['Invites Sent'] = invitesSent|| 'N/A';
        row['Hires'] = hires|| 'N/A';
        row['Preferred Language'] = preferredLanguage.join(', ') || 'N/A';
        row['Preferred Location'] = preferredLocation.join(', ') || 'N/A';
        row['Status'] = status;

        console.log(`✅ ${link},  Member Since: ${memberSince}, Joined Recently: ${joinedRecently}, Hire Rate: ${hireRate}, Total Spent: ${totalSpent}, Interviewing: ${interviewing}, Invites Sent: ${invitesSent}, Hires: ${hires}`);

        updatedData.push(row);
    }

    
    // Extract headers from the first row (original headers)
    const originalHeaders = Object.keys(data[0] || {});
    const newHeaders = ['Hire Rate', 'Member Since', 'Status'];

    // Create the final header order: original + new (only if not already present)
    const finalHeaders = [...originalHeaders];
    for (const h of newHeaders) {
        if (!finalHeaders.includes(h)) finalHeaders.push(h);
    }

    // Create a new worksheet with specific header order
    const newSheet = XLSX.utils.json_to_sheet(updatedData, { header: finalHeaders });


    // const newSheet = XLSX.utils.json_to_sheet(updatedData);
    workbook.Sheets[sheetName] = newSheet;
    XLSX.writeFile(workbook, filePath);

    console.log(`📥 Updated Excel file saved with client status: ${filePath}`);
}






(async () => {
    // Launch the browser in non-headless mode
    const browser = await puppeteer.launch({
        headless: false,
    });

    const page = await browser.newPage();
    // Set a realistic user agent string
    // await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.88 Safari/537.36');

    // set the viewport to 1920x1080 to avoid the cookie banner 
    // await page.setViewport({
    //     width: 1920,
    //     height: 1080
    // });
    await page.goto('https://www.upwork.com/ab/account-security/login',{
        waitUntil: 'load',
    });
    await new Promise(resolve => setTimeout(resolve, 1000));   

    // getting the email and password from the .env file
    const email = process.env.EMAIL;
    const password = process.env.PASSWORD;

    await new Promise(r => setTimeout(r, 3000));

    // enter the email and password
    await page.type('#login_username', email);
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // click the "continue with email" button
    await new Promise(r => setTimeout(r, 1000));
    
    await page.click('#login_password_continue');
    // some randomness to the mouse movement
    for (let i = 0; i < 10; i++) {
        await page.mouse.move(getRndm(0, 10000), getRndm(0, 1000));
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    // password
    await page.type('#login_password', password);
    await page.click('#login_control_continue');
    // move the mouse randomly to be more human 
    for (let i = 0; i < 10; i++) {
        await page.mouse.move(getRndm(0, 20000), getRndm(0, 10000));
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    
    const latestFile = getLatestExcelFile('./Data');

    if (latestFile) {
        console.log(`📄 Latest file: ${latestFile}`);
        await extractAndCheckLinksFromExcel(page, latestFile);
    } else {
        console.log('⚠️ No Excel files found in output folder.');
    }


   
    const randomDelay = Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, randomDelay));
    // Close the browser
    await browser.close();
    // write to json file by overriding the file
})();

















// // npm install puppeteer-extra puppeteer-extra-plugin-stealth
// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// // add the stealth plugin
// puppeteer.use(StealthPlugin());

// function getRndm(min, max) {
//     return Math.floor(Math.random() * (max - min + 1) + min);
// }

// (async () => {
//     // set up browser environment
//     const browser = await puppeteer.launch({
//         headless: false,
//     });
//     const page = await browser.newPage();

//     // navigate to a URL
//     await page.goto('https://www.upwork.com/ab/account-security/login', {
//         waitUntil: 'load',
//     });

//     // getting the email and password from the .env file
//     const email = 'nikh@silentinfotech.com';
//     const password = 'Summer@123';

//     // take page screenshot
//     await page.screenshot({ path: 'screenshot1.png' });

//     await page.type('#login_username', email, { delay: 100 });
    
//     // click the "continue with email" button
//     await new Promise(r => setTimeout(r, 3000));

//     await page.click('#login_password_continue');

//     for (let i = 0; i < 10; i++) {
//         await page.mouse.move(getRndm(0, 10000), getRndm(0, 1000));
//         await  new Promise(r => setTimeout(r, 3000));
//     }
//     // password
//     await page.type('#login_password', password);
//     await page.screenshot({ path: 'screenshot2.png' });
//     await page.click('#login_control_continue');

//     // close the browser instance
//     await browser.close();
// })();
