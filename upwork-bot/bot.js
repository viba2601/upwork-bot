
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

function tooOld(time) {
    time = time.toLowerCase();
    if (time.includes('minute') || time.includes('hour') || time.includes('just now')) return false;
    if (time.includes('day')) {
        let num = parseInt(time);
        return num > 15;
    }
    if (time.includes('month') || time.includes('year')) return true;
    return true; // fallback: if format is unknown, assume it's old
}


function tooCheap(typeOfJob) {
    if (!typeOfJob || !typeOfJob.budget) return true;

    if (typeOfJob.type.includes('Fixed')) {
        let budget = parseInt(typeOfJob.budget.replace(/[^0-9]/g, ''));
        console.log(`Fixed price job with budget: $${budget}`);
        return budget < 300;
    }
    if (typeOfJob.type.includes('Hourly')) {
        let match = typeOfJob.budget.match(/\$?(\d+)/);
        if (match) {
            let budget = parseInt(match[1]);
            console.log(`Hourly job with budget: $${budget}`);
            return budget < 15;
        }
    }
    return true;
}


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
    await page.waitForTimeout(1000);
    // Wait for the page to load 
    

    // getting the email and password from the .env file
    const email = process.env.EMAIL;
    const password = process.env.PASSWORD;

    // await new Promise(r => setTimeout(r, 3000));

    // enter the email and password
    await page.type('#login_username', email, { delay: 100 });
    await page.waitForTimeout(1000);
    
    // click the "continue with email" button
    await page.screenshot({ path: 'Login-click.png' });
    await new Promise(r => setTimeout(r, 1000));
    
    await page.click('#login_password_continue');
    // some randomness to the mouse movement
    for (let i = 0; i < 10; i++) {
        await page.mouse.move(getRndm(0, 10000), getRndm(0, 1000));
        await page.waitForTimeout(1000);
    }
    // password
    await page.type('#login_password', password);
    await page.screenshot({ path: 'before-click.png' });
    await page.click('#login_control_continue');
    // move the mouse randomly to be more human 
    for (let i = 0; i < 10; i++) {
        await page.mouse.move(getRndm(0, 20000), getRndm(0, 10000));
        await page.waitForTimeout(1500);
    }
    // wait for the page to load
    // wait for the search input to load 
    let allJobs = [];

    // wait for search input to load
    // await page.waitForSelector('input[placeholder="Search for job"]', { visible: true });
    for (let i = 0; i < keywords.length; i++) {
        // console.log('searching for ' + keywords[i]);
        for (let j = 1; j < 6; j++) {
            // scrolling throught 5 pages 
            await page.goto('https://www.upwork.com/nx/jobs/search/?q=' + keywords[i] + '&sort=recency' + '&page=' + j);
            await page.waitForTimeout(3000);
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
                    if (tooCheap(typeOfJob)) {
                        console.log(`Skipping "${title}" because it's too cheap:`, typeOfJob.budget);
                        return;
                    }
            
                    let paymentverified = await isVerified(listing);
                    return { posted, title, link, description, typeOfJob, paymentverified };
                } catch (err) {
                    console.error('Error processing job:', err.message);
                    return;
                }
            }));
            // filter out the undefined jobs and already pushed jobs
            // jobs = jobs.filter((job) => job !== undefined && !jobs.includes(job));
            // push jobs to alljobs
            allJobs.push(...jobs);
            console.log('Collected jobs:', allJobs.length);
        }

    }
    // Add some randomness to the requests
    const randomDelay = Math.random() * 2000;
    await page.waitForTimeout(randomDelay);
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
        "Payment Verified": job.paymentverified || false
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
  
      XLSX.writeFile(workbook, filename);
  
      
      console.log(`✅ Excel file created: ${filename}`);
    
})();



