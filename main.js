import fs from 'fs';
import path from 'path';
import fsp from 'fs/promises';
import { consola } from 'consola';
import { Mutex } from 'async-mutex';
import { request, ProxyAgent } from 'undici';
import Enquirer from 'enquirer';
import chalk from 'chalk';



// Initialize Enquirer
const enquirer = new Enquirer();

// Print stylized header
const printHeader = () => {
    console.log(chalk.blue(`
@@@@@@@  @@@@@@@   @@@@@@  @@@@@@@@@@   @@@@@@         @@@@@@@ @@@  @@@ @@@@@@@@  @@@@@@@ @@@  @@@ @@@@@@@@ @@@@@@@  
@@!  @@@ @@!  @@@ @@!  @@@ @@! @@! @@! @@!  @@@       !@@      @@!  @@@ @@!      !@@      @@!  !@@ @@!      @@!  @@@ 
@!@@!@!  @!@!!@!  @!@  !@! @!! !!@ @!@ @!@  !@!       !@!      @!@!@!@! @!!!:!   !@!      @!@@!@!  @!!!:!   @!@!!@!  
!!:      !!: :!!  !!:  !!! !!:     !!: !!:  !!!       :!!      !!:  !!! !!:      :!!      !!: :!!  !!:      !!: :!!  
 :        :   : :  : :. :   :      :    : :. :         :: :: :  :   : : : :: ::   :: :: :  :   ::: : :: ::   :   : : 
    `));
}

// Define input and output folders
const inputFolder = './input';
const timestamp = new Date().toISOString().replace(/[-:.T]/g, '');
const outputFolder = path.join('./output', `run_${timestamp}`);

// Create output folder
fs.mkdirSync(outputFolder, { recursive: true });

// Utility class for file operations
class Utility {
    static async readFileAsArray(filePath) {
        const maxLines = Infinity; // Set to Infinity for no limit
        const dataSet = new Set();
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
        let buffer = '';

        return new Promise((resolve, reject) => {
            stream.on('data', chunk => {
                buffer += chunk;
                let boundary = buffer.lastIndexOf('\n');
                if (boundary >= 0) {
                    let lines = buffer.slice(0, boundary).split('\n');
                    buffer = buffer.slice(boundary + 1);

                    lines.forEach(line => {
                        if (line.trim()) {
                            dataSet.add(line.trim());
                        }
                        if (dataSet.size >= maxLines) {
                            stream.destroy(); // Stop reading if maxLines is reached
                        }
                    });
                }
            });

            stream.on('end', () => {
                if (buffer) {
                    let lines = buffer.split('\n');
                    lines.forEach(line => {
                        if (line.trim()) {
                            dataSet.add(line.trim());
                        }
                    });
                }
                resolve(Array.from(dataSet));
            });

            stream.on('error', err => {
                reject(err);
            });
        });
    }

    static createProxyAgent(proxyUrl) {
        if (!proxyUrl.startsWith('http'))
            proxyUrl = `http://${proxyUrl}`

        const parsed = new URL(proxyUrl)

        let opts = { uri: proxyUrl }

        if (parsed.username && parsed.password)
            opts.auth = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')

        return new ProxyAgent(opts)
    }
}

// Class to manage input arrays
class InputManager {
    constructor(array, opts = {}) {
        this.array = array;

        if (opts.formatSlug)
            this.array = this.array.map((x) => x.includes('/') ? x.split('/')[x.match(/\//g).length] : x)

        if (opts.cleanStrings)
            this.array = this.array.map((x) => x.replace(/[^a-zA-Z0-9]/g, '').trim())

        this.opts = opts;
        this.index = 0;
    }

    get() {
        if (!this.opts.loop && this.index >= this.array.length) {
            return null;
        }
        return this.array[
            this.opts.loop ? this.index++ % this.array.length : this.index++
        ];
    }
}

// Class to manage output files
class OutputManager {
    constructor(dir, opts = {}) {
        this.dir = dir;
        this.opts = opts;

        fs.writeFileSync(this.dir, ''); // Initialize file

        this.mutex = new Mutex();
    }

    async write(line) {
        const release = await this.mutex.acquire();

        if (this.opts.prefix)
            line = this.opts.prefix + line

        try {
            await fsp.appendFile(this.dir, line + '\n');
        } finally {
            release();
        }
    }

    async writeSummary(counters) {
        const summary = `Total: ${counters.total}\n` +
                        `3 Month: ${counters.month3}\n` +
                        `1 Month: ${counters.month1}\n` +
                        `Invalid: ${counters.invalid}\n` +
                        `Used: ${counters.used}\n\n`;
        fs.writeFileSync(this.dir, summary + fs.readFileSync(this.dir, 'utf-8'));
    }
}

// Main execution
const start = async () => {
    printHeader();

    const proxies = await Utility.readFileAsArray(path.join(inputFolder, 'proxies.txt'));
    consola.info(`Loaded ${proxies.length} proxies`);

    const promos = await Utility.readFileAsArray(path.join(inputFolder, 'promos.txt'));
    consola.info(`Loaded ${promos.length} promos`);

    const ProxyInputManager = new InputManager(proxies, { loop: true });
    const PromoInputManager = new InputManager(promos, { formatSlug: true, cleanStrings: true });

    const ThreeMonthPromoManager = new OutputManager(path.join(outputFolder, '3month.txt'), { prefix: 'https://promos.discord.gg/' });
    const OneMonthPromoManager = new OutputManager(path.join(outputFolder, '1month.txt'), { prefix: 'https://promos.discord.gg/' });
    const InvalidPromoManager = new OutputManager(path.join(outputFolder, 'invalid.txt'), { prefix: 'https://promos.discord.gg/' });
    const UsedPromoManager = new OutputManager(path.join(outputFolder, 'used.txt'), { prefix: 'https://promos.discord.gg/' });

    // Initialize counters object
    const counters = {
        total: 0,
        month3: 0,
        month1: 0,
        invalid: 0,
        used: 0,
    };

    const getPromoResponse = (proxy, code) => new Promise(async (resolve) => {
        const retries = 3;
        const requestTimeout = 5000;
        const failTimeout = 2000;

        if (proxy) var agent = Utility.createProxyAgent(proxy);

        let fails = [];

        for (let i = 0; i < retries; i++) {
            try {
                const req = await request(`https://discord.com/api/v9/entitlements/gift-codes/${code}`, {
                    headersTimeout: requestTimeout,
                    bodyTimeout: requestTimeout,
                    ...agent && { dispatcher: agent },
                });

                try {
                    var body = await req.body.json();
                } catch {
                    throw new Error('Failed to parse response. Most likely proxy error or cloudflare rate limit.');
                }

                return resolve(body);
            } catch (e) {
                fails.push(e);
                await new Promise((resolve) => setTimeout(resolve, failTimeout));
            }
        }

        resolve({ e: `All of total ${retries} have failed: ${fails.join(', ')}` });
    });

    const updateProcessTitle = () => {
        process.title = `Valid: ${counters.month3 + counters.month1} | Invalid: ${counters.invalid} | Used: ${counters.used} | Total: ${counters.total}`;
    };

    const Thread = async (id) => {
        while (true) {
            const proxy = ProxyInputManager.get();
            const promo = PromoInputManager.get();
            if (!promo) {
                // consola.info(`Thread ${id} has ran out of promos`);
                break;
            }

            const result = await getPromoResponse(proxy, promo);
            let done = false;

            switch (result?.message) {
                case 'Unknown Gift Code':
                    counters.invalid += 1;
                    const current_time = new Date().toLocaleTimeString();
            
                    consola.info(
                        chalk.gray(`${current_time}`) + 
                        chalk.white(` → `) +
                        chalk.blue(` INF `) +
                        chalk.white(` • `) +
                        chalk.red(` INVALID `) +
                        chalk.blue(` PROMO CODE `) +
                        chalk.gray(` → `) + 
                        chalk.white(`${promo}`) 
                        // chalk.gray(` - ${counters.total + 1}/${PromoInputManager.array.length}`)
                    );
            
                    await InvalidPromoManager.write(promo);
                    done = true;
                    break;
            
                case 'The resource is being rate limited.':
                    PromoInputManager.array.push(promo);
                    done = true;
                    break;
            }
            

            if (result?.uses != result?.max_uses) {
                const promoType = result?.promotion?.inbound_header_text?.includes('3 months') ? 3 : 1;
                const logType = promoType == 3 ? ThreeMonthPromoManager : OneMonthPromoManager;
                counters[`month${promoType}`] += 1;
            
                const current_time = new Date().toLocaleTimeString(); // adaugă ora și data curentă
                consola.info(
                    chalk.gray(`${current_time}`) + 
                    chalk.white(` → `) +
                    chalk.blue(` INF `) +
                    chalk.white(` • `) +
                    chalk.green(`${promoType} MONTH`) + 
                    chalk.gray(` → `) +
                    chalk.green(` VALID `) +
                    chalk.blue(` MONTH PROMO CODE `) +
                    chalk.gray(` → `) + 
                    // chalk.green(`https://promos.discord.gg/`) +
                    chalk.gray(`${promo}`)
                );
                
                await logType.write(promo);
                done = true;
            }
            

            if (result?.uses && result?.uses == result?.max_uses) {
                counters.used += 1;
                const current_time = new Date().toLocaleTimeString();
            
                consola.info(
                    chalk.gray(`${current_time}`) + 
                    chalk.white(` → `) +
                    chalk.blue(` INF `) +
                    chalk.white(` • `) +
                    chalk.yellow(` USED `) +
                    chalk.blue(` PROMO CODE `) +
                    chalk.white(` → `) + 
                    chalk.gray(`${promo}`) 
                    // chalk.gray(` - ${counters.total + 1}/${PromoInputManager.array.length}`)
                );
                
                await UsedPromoManager.write(promo);
                done = true;
            }

            if (!done) {
                consola.info(chalk.red(`[${id}] Unknown response: https://promos.discord.gg/${promo} - ${counters.total + 1}/${PromoInputManager.array.length}`));
            }

            counters.total += 1;
            updateProcessTitle();
        }
    };

    let threadsAmount = parseInt((await enquirer.prompt({
        type: 'input',
        name: 'threads',
        message: 'How many threads do you want to run?',
        initial: 1
    })).threads);

    if (threadsAmount > promos.length) {
        threadsAmount = promos.length;
        consola.warn(`Threads amount is higher than promos amount. Setting threads amount to ${threadsAmount}`);
    }

    for (let i = 0; i < threadsAmount; i++) {
        Thread(i + 1);
    }

    // Wait for all threads to complete before writing summaries
    await new Promise(resolve => setTimeout(resolve, 10000)); // Adjust the timeout as needed

    await Promise.all([
        ThreeMonthPromoManager.writeSummary(counters),
        OneMonthPromoManager.writeSummary(counters),
        InvalidPromoManager.writeSummary(counters),
        UsedPromoManager.writeSummary(counters)
    ]);

    consola.success('Processing completed. Summary written to output files.');
};

start().catch(err => consola.error('Error during processing:', err));
