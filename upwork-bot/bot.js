// if there's a timeout error, wait for 10 seconds and run the script again 

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

// add the stealth plugin
puppeteer.use(StealthPlugin());
const fs = require('fs');
const XLSX = require('xlsx');
require('dotenv').config();

function getRndm(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

// get the type of job
async function getTypeOfJob(listing) {
    let type = await listing.$eval('li[data-test="job-type-label"] strong', (el) => el.innerText);
    // if type is hourly get the budget from the same element <strong data-test="job-type">
    // let budget = '';
    if (type.includes('Hourly')) {
        // search for $ sign in the text
        let index = type.indexOf('$');
        // console.log(index);
        // if budget is specified
        if (index !== -1) {
            // get the budget
            let budget = type.substring(index);
            // remove the budget from the type
            type = type.substring(0, index);
            return { type, budget };
        } else {
            // if budget is not specified
            let budget = 'not specified';
            return { type, budget };
        }
        // get the budget
    }
    else if (type.includes('Fixed price')) {
        let budget = await listing.$eval('li[data-test="is-fixed-price"] strong:last-of-type', el => el.innerText.trim());
        return { type, budget };
    }
}

async function isVerified(listing) {
    // check if the payment is verified
    let status = await listing.$eval('li[data-test="payment-verified"] .air3-badge-tagline', el => el.innerText.trim());
    return status === "Payment verified";
}

async function getTitle(listing) {
    // get the title of the job which in <a href="/jobs/..."> title </a>
    let title = await listing.$eval('a[href^="/jobs/"]', (a) => a.innerText);
    return title;

}

async function getLink(listing) {
    // get the link of the job which is in <h4 class="job-tile-title"> <a href="link"> </a> </h4>
    return await listing.$eval('a[href^="/jobs/"]', (a) => a.href);

}

async function getDescription(listing) {
    // get the description of the job which in <span data-test="job-tile-description">
    let description = await listing.$eval('p.mb-0.text-body-sm', el => el.innerText);
    return description;
}

async function getTime(listing) {
    // get the time of the job which in <span data-test="UpCRelativeTime">
    let time = await listing.$eval('small[data-test="job-pubilshed-date"]', el => el.innerText);
    return time;
}

async function getCountry(listing){
    let country = await listing.$eval('li[data-test="location"] span:last-of-type', el => el.textContent.trim());
    return country;
}

async function getEstimatetime(listing){
    try {
        let estTime = await listing.$eval('li[data-test="duration-label"] strong:last-of-type', el => el.innerText);
        return estTime;
    } catch (error) {
        return null; // or 'None' as a string if you're exporting to CSV or Excel
    }
}


async function getSpent(listing){
    let totalSpent = await listing.$eval('li[data-test="total-spent"] strong', el => el.innerText.trim());
    return totalSpent;
}

function tooOld(time) {
    time = time.toLowerCase();
    if (time.includes('seconds') || time.includes('minute') || time.includes('hour') || time.includes('just now') || time.includes('yesterday')) return false;
    // if (time.includes('day')) {
    //     let num = parseInt(time);
    //     return num >= 2;
    // }
    if (time.includes('month') || time.includes('year')) return true;
    return true; // fallback: if format is unknown, assume it's old
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

function getPriority(estTime) {
    if (!estTime) return '';

    const time = estTime.toLowerCase();

    if (time.includes('less than 1 month')) return 'P4';
    if (time.includes('1 to 3 months')) return 'P3';
    if (time.includes('3 to 6 months')) return 'P2';
    if (time.includes('more than 6 months')) return 'P1';

    return '';
}



// function tooCheap(typeOfJob) {
//     if (!typeOfJob || !typeOfJob.budget) return true;

//     if (typeOfJob.type.includes('Fixed')) {
//         let budget = parseInt(typeOfJob.budget.replace(/[^0-9]/g, ''));
//         console.log(`Fixed price job with budget: $${budget}`);
//         return budget < 300;
//     }
//     if (typeOfJob.type.includes('Hourly')) {
//         let match = typeOfJob.budget.match(/\$?(\d+)/);
//         if (match) {
//             let budget = parseInt(match[1]);
//             console.log(`Hourly job with budget: $${budget}`);
//             return budget < 15;
//         }
//     }
//     return true;
// }


(async () => {
    const startTime = new Date();
    // reading keywords from keywords.txt file
    let keywords = fs.readFileSync('./keywords.txt', 'utf-8');
    keywords = keywords.split('\n');
    for (let i = 0; i < keywords.length; i++) {
        keywords[i] = keywords[i].trim();
    }
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
    // Wait for the page to load 
    

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
    // wait for the page to load
    // wait for the search input to load 
    let allJobs = [];

    // wait for search input to load
    // await page.waitForSelector('input[placeholder="Search for job"]', { visible: true });
    for (let i = 0; i < keywords.length; i++) {
        // console.log('searching for ' + keywords[i]);
        for (let j = 1; j < 3; j++) {
            // scrolling through 2 pages 
            await page.goto('https://www.upwork.com/nx/jobs/search/?q=' + keywords[i] + '&sort=recency' + '&page=' + j);
            await new Promise(resolve => setTimeout(resolve, 5000));
            // await page.waitForSelector('div[data-test="main-tabs-index"]', { visible: true });
            // get all sections with data-test="JobTile"
            const listings = await page.$$('article[data-test="JobTile"]');
            // change the page number of jobs
            let jobs = await Promise.all(listings.map(async (listing) => {
                try {
                    let posted = await getTime(listing);
                    if (tooOld(posted)) {
                        console.log('Skipping job because it is too old:', posted);
                        return;
                    }
            
                    let title = await getTitle(listing);
                    let link = await getLink(listing);
                    let description = await getDescription(listing);
                    let typeOfJob = await getTypeOfJob(listing);
                    let country = (await getCountry(listing)).replace(/^Location\s*/i, '').trim();
                    let estTime = await getEstimatetime(listing);
                    let priority = await getPriority(estTime);
                    let totalSpent = await getSpent(listing);
                    let paymentverified = await isVerified(listing);
                    // console.log("Job Type", typeOfJob.type.trim().replace(/:$/, '').toLowerCase());
                    const filters = readFilters();
                
                    if (
                        filters.payment_verified && filters.payment_verified !== String(paymentverified) ||

                        filters.country &&
                        (
                            Array.isArray(filters.country)
                                ? !filters.country.includes(country.toLowerCase())
                                : filters.country !== country.toLowerCase()
                        ) ||

                        filters.total_spent && !totalSpent.includes(filters.total_spent) ||

                        filters.job_type &&
                        (
                            
                            Array.isArray(filters.job_type)
                                ? !filters.job_type.includes(typeOfJob.type.trim().replace(/:$/, '').toLowerCase())
                                : filters.job_type !== typeOfJob.type.trim().replace(/:$/, '').toLowerCase()
                        )  
                    ) {
                        console.log(`Skipping "${title}" due to filter mismatch.`);
                        return;
                    }

                    if (
                        typeOfJob.type.trim().replace(/:$/, '').toLowerCase().includes('hourly') &&
                        typeOfJob.budget &&
                        typeOfJob.budget !== 'not specified' &&
                        filters.hourly_min_rate !== undefined &&
                        filters.hourly_max_rate !== undefined
                    ) {
                        const match = typeOfJob.budget.match(/\$([\d.]+)\s*-\s*\$([\d.]+)/);
                        if (match) {
                            const min = parseFloat(match[1]);
                            const max = parseFloat(match[2]);
                    
                            if (
                                (filters.hourly_min_rate !== null && max < filters.hourly_min_rate) ||
                                (filters.hourly_max_rate !== null && min > filters.hourly_max_rate)
                            ) {
                                console.log(`Skipping "${title}" due to hourly rate outside filter range.`);
                                return;
                            }
                            
                        } else {
                            // If budget doesn't match expected pattern
                            console.log(`Skipping "${title}" due to invalid hourly range format.`);
                            return;
                        }
                    
                    }

                    if (
                        typeOfJob.type.trim().replace(/:$/, '').toLowerCase().includes('fixed') &&
                        typeOfJob.budget &&
                        typeOfJob.budget !== 'not specified' &&
                        (filters.fixed_min_budget !== null || filters.fixed_max_budget !== null)
                    ) {
                        const budgetVal = parseFloat(typeOfJob.budget.replace(/[^0-9.]/g, ''));
                        
                        if (
                            (filters.fixed_min_budget !== null && budgetVal < filters.fixed_min_budget) ||
                            (filters.fixed_max_budget !== null && budgetVal > filters.fixed_max_budget)
                        ) {
                            console.log(`Skipping "${title}" due to fixed budget outside filter range.`);
                            return;
                        }
                    }
                    

                    // if (tooCheap(typeOfJob)) {
                    //     console.log(`Skipping "${title}" because it's too cheap:`, typeOfJob.budget);
                    //     return;
                    // }
            
                    
                    return { posted, title, link, description, typeOfJob, paymentverified, country, estTime, totalSpent, priority };
                } catch (err) {
                    console.error('Error processing job:', err.message);
                    return;
                }
            }));
            allJobs.push(...jobs);
            console.log('Collected jobs:', allJobs.length);
        }

    }
    // Add some randomness to the requests
    const randomDelay = Math.random() * 2000;
    await new Promise(resolve => setTimeout(resolve, randomDelay));
    // Close the browser
    await browser.close();
    // write to json file by overriding the file
    const formattedJobs = allJobs.filter(Boolean).map(job => ({
        Posted: job.posted || '',
        Title: job.title || '',
        Link: job.link || '',
        Description: job.description || '',
        "Job Type": job.typeOfJob?.type || '',
        Budget: job.typeOfJob?.budget || '',
        "Country": job.country || '',
        "Estimated Time": job.estTime || '',
        "Total Spent": job.totalSpent || '',
        "Payment Verified": job.paymentverified ? "True" : "False",
        "Priority": job.priority || '',
      }));
      
    // Create a worksheet and workbook
    const worksheet = XLSX.utils.json_to_sheet(formattedJobs);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Upwork Jobs");
    
    // Build filename using current date and time
    const endTime = new Date();  // <--- ADD THIS BEFORE FILENAME LOGIC

    const pad = n => n.toString().padStart(2, '0');

    const formatDate = d =>
        `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}`;
    const formatTime = d =>
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

    const date = formatDate(startTime);
    const start = formatTime(startTime);
    const end = formatTime(endTime);

    const filename = `upwork_bot_jobs_${date}_${start}_${end}.xlsx`;

    const outputFolder = './Data';
    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
    }
  
    const path = require('path');
    const fullPath = path.join(outputFolder, filename);

    XLSX.writeFile(workbook, fullPath);
      
    console.log(`✅ Excel file created: ${filename}`);
    
})();
