const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const RSSParser = require('rss-parser');

const axios = require('axios');
const cheerio = require('cheerio'); 

// --- 1. CONFIGURATION ---
// IMPORTANT: Replace these placeholders with your actual values.
const DISCORD_BOT_TOKEN = "T";

// How often to check the RSS feed (in milliseconds). 1800000ms = 30 minutes.
const CHECK_INTERVAL_MS = 1800000; 

// Define all RSS feeds the bot should monitor.
const FEEDS = [
    {
        name: "Announcement", // Used for logging and embed title
        url: "https://weber-cyber-club.github.io/announcements/index.xml",
        channelId: "1443647723038572566",
        color: '#492365', // Purple color
        tag: '@Website_Announcements', // The role/user to ping
        footerText: 'New Announcement Posted!',
        baseUrl: 'https://weber-cyber-club.github.io', // Base URL for resolving relative image paths
    },
    {
        name: "Lab",
        url: "https://weber-cyber-club.github.io/labs/index.xml",
        channelId: "1443647723038572566",
        color: '#492365', 
        tag: '@Labs_Role',
        footerText: 'New Lab Available!',
        baseUrl: 'https://weber-cyber-club.github.io', // Base URL for resolving relative image paths
    },
    {
        name: "Challenge",
        url: "https://weber-cyber-club.github.io/challenges/index.xml",
        channelId: "1443647723038572566",
        color: '#492365', 
        tag: '@Challenge_Role',
        footerText: 'New Challenge Launched!',
        baseUrl: 'https://weber-cyber-club.github.io',
    },
    {
        name: "Cyber News",
        url: "https://www.bleepingcomputer.com/feed/",
        channelId: "1443705050437521418",
        color: '#492365', 
        tag: '@Cyber_News',
        footerText: 'New Cyber News!',
        baseUrl: "https://www.bleepingcomputer.com" ,
    },
    {
        name: "Cyber News",
        url: "https://feeds.feedburner.com/TheHackersNews",
        channelId: "1443705050437521418",
        color: '#492365', 
        tag: '@Cyber_News',
        footerText: 'New Cyber News!',
        baseUrl: "https://thehackernews.com"
    },
    {
        name: "Cyber News",
        url: "https://therecord.media/feed",
        channelId: "1443705050437521418",
        color: '#492365', 
        tag: '@Cyber_News',
        footerText: 'New Cyber News!',
        baseUrl: "https://therecord.media"
    }
];

// --- 2. INITIALIZATION ---

// Initialize the Discord Client
const client = new Client({ 
    intents: [
        // GUILDS intent is required for the bot to see servers and channels
        GatewayIntentBits.Guilds,
    ] 
});

const parser = new RSSParser();

// Use a Map to store the last announced title for each feed URL, ensuring independence.
let lastAnnouncedTitles = new Map(); 

// --- HELPER FUNCTION: IMAGE EXTRACTION (Cheerio Implementation) ---

/**
 * Fetches the HTML content from the article link, parses it using Cheerio,
 * extracts the image using a series of priority selectors, and resolves relative paths.
 * @param {string} articleLink The direct URL to the full article.
 * @param {string | null} baseUrl The base URL of the website to resolve relative paths.
 * @returns {Promise<string | null>} The absolute image URL or null if none is found or an error occurs.
 */
async function fetchAndExtractImageUrl(articleLink, baseUrl = null) {
    if (!articleLink) return null;

    try {
        // 1. Fetch the HTML content of the article link
        const { data: html } = await axios.get(articleLink, {
            // Use a User-Agent to mimic a browser, which helps prevent blocking by some websites.
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Discord-RSS-Bot/1.0; +https://weber-cyber-club.github.io/)'
            },
            timeout: 10000 // 10 second timeout for the request
        });

        // 2. Load the HTML into cheerio
        const $ = cheerio.load(html);

        let imageUrl = null;

        // --- PRIORITY 1: Find the <img> with the class 'post-cover' ---
        const $coverImage = $('img.post-cover').first();
        if ($coverImage.length) {
            imageUrl = $coverImage.attr('src');
            if (imageUrl) {
                console.log(`[Image] Found image using P1 selector 'img.post-cover'.`);
            }
        }

        // --- FALLBACK 1: Find the first <img> inside an element with class 'post' ---
        if (!imageUrl) {
            const $postImage = $('.post img').first();
            if ($postImage.length) {
                imageUrl = $postImage.attr('src');
                if (imageUrl) {
                    console.log(`[Image] Falling back to F1 selector '.post img'.`);
                }
            }
        }
        
        // --- FALLBACK 2: Find the first <img> inside the <article> tag ---
        if (!imageUrl) {
            const $articleImage = $('article img').first();
            if ($articleImage.length) {
                imageUrl = $articleImage.attr('src');
                if (imageUrl) {
                    console.log(`[Image] Falling back to F2 selector 'article img'.`);
                }
            }
        }

        // --- FALLBACK 3: Find the very first <img> tag on the page (generic) ---
        if (!imageUrl) {
            const $firstImage = $('img').first();
            imageUrl = $firstImage.attr('src');
            if (imageUrl) {
                console.log(`[Image] Falling back to F3 selector 'img'.`);
            }
        }
        
        // --- FALLBACK 4: Check Open Graph or Twitter Card meta tags ---
        if (!imageUrl) {
            const ogImage = $('meta[property="og:image"]').attr('content');
            const twitterImage = $('meta[name="twitter:image"]').attr('content');
            imageUrl = ogImage || twitterImage;
            if (imageUrl) {
                console.log(`[Image] Falling back to F4 meta tags (og:image or twitter:image).`);
            }
        }

        if (!imageUrl) {
            console.log(`[Image] No suitable image found on the page: ${articleLink}`);
            return null;
        }

        // 3. Resolve relative URL to absolute URL if a base URL is provided
        if (baseUrl && imageUrl.startsWith('/')) {
            const normalizedBase = baseUrl.replace(/\/$/, '');
            imageUrl = `${normalizedBase}${imageUrl}`;
            console.log(`[Image] Resolved relative URL to: ${imageUrl}`);
        }
        
        // Final check to ensure it's a valid, absolute link
        if (imageUrl && imageUrl.startsWith('http')) {
            return imageUrl;
        }

        return null;

    } catch (error) {
        console.error(`[Image] Error fetching article content from ${articleLink}: ${error.message}`);
        // Log the error but return null so the announcement can still be made
        return null; 
    }
}


// --- 3. CORE LOGIC: RSS CHECKER FUNCTIONS ---

/**
 * Checks a single RSS feed for new items and announces them to Discord.
 * @param {object} feedConfig Configuration object for the current feed.
 */
async function processFeed(feedConfig) {
    const { name, url } = feedConfig;
    console.log(`[RSS] Checking feed: ${name} (${url})`);

    try {
        const feed = await parser.parseURL(url);
        
        if (feed.items.length === 0) {
            console.log(`[RSS] ${name} feed is empty.`);
            return;
        }

        const latestItem = feed.items[0];
        const lastTitle = lastAnnouncedTitles.get(url); // Get last title specific to this URL

        // 3a. Initial setup check: Set the baseline upon first run
        if (lastTitle === undefined) {
            lastAnnouncedTitles.set(url, latestItem.title);
            console.log(`[RSS] Initializing ${name}. Last announced post: "${latestItem.title}"`);
            // Announce the latest post immediately on startup
            await announceNewPost(latestItem, feedConfig); 
            return;
        }
        
        // 3b. Comparison check: Is the latest title different from the last one announced?
        if (latestItem.title !== lastTitle) {
            console.log(`[RSS] New update found for ${name}! "${latestItem.title}"`);
            
            // Loop through items until we hit the last announced title
            let newUpdates = [];
            for (const item of feed.items) {
                if (item.title === lastTitle) {
                    break; 
                }
                newUpdates.push(item);
            }

            // Reverse to announce in newest-to-oldest order
            newUpdates.reverse();
            
            for (const update of newUpdates) {
                await announceNewPost(update, feedConfig);
            }

            // Update the baseline for this feed after all new posts have been announced
            lastAnnouncedTitles.set(url, latestItem.title);

        } else {
            console.log(`[RSS] No new updates for ${name} since: "${lastTitle}"`);
        }

    } catch (error) {
        console.error(`[RSS] Error fetching or parsing ${name} feed: ${error.message}`);
    }
}

/**
 * Checks all configured RSS feeds. This is the function called by the scheduler.
 */
async function checkAllRssFeeds() {
    for (const feed of FEEDS) {
        await processFeed(feed);
    }
}

/**
 * Sends a stylized embedded message to the Discord channel associated with the feed.
 * @param {object} item The RSS feed item object.
 * @param {object} feedConfig Configuration object for the current feed.
 */
async function announceNewPost(item, feedConfig) {
    // Destructure baseUrl along with other properties
    const { name, channelId, color, tag, footerText, url, baseUrl } = feedConfig; 
    
    try {
        // Use client.channels.fetch(ID) to ensure we look up the channel successfully
        const channel = await client.channels.fetch(channelId);
        
        if (!channel) {
            // Log a detailed error message if fetch fails
            console.error(`[Discord] FATAL ERROR: Could not find channel for ${name} with ID: ${channelId}. 
            Possible reasons: 
            1. The ID is incorrect.
            2. The bot does not have 'View Channel' permission for this channel.
            3. The bot is not in the server where this channel exists.
            `);
            return;
        }

        // --- Image Extraction Logic: Use Cheerio on the article link ---
        // We use item.link (the URL of the full article) to fetch the HTML
        const imageUrl = await fetchAndExtractImageUrl(item.link, baseUrl); 

        // Create a Discord Embed
        const announcementEmbed = new EmbedBuilder()
            .setColor(color) 
            .setTitle(item.title)
            .setURL(item.link)
            .setAuthor({ name: `${name} Update | Weber State Cyber Club`, iconURL: client.user.displayAvatarURL() })
            .setDescription(item.contentSnippet ? item.contentSnippet.substring(0, 200) + '...' : 'Click the link to read the full update!')
            .setTimestamp(item.pubDate ? new Date(item.pubDate) : new Date())
            .setFooter({ text: footerText });

        // If an image URL was successfully extracted, set it on the embed
        if (imageUrl) {
            announcementEmbed.setImage(imageUrl);
            console.log(`[Image] Found image for ${name}: ${imageUrl}`);
        }

        // --- Message Content Logic ---
        let messageContent;

        if (tag === "@Cyber_News") {
            // Custom message for Cyber News, using the destructured 'url' variable
            messageContent = `${tag} new Cyber News has been released on ${baseUrl} !`;
        } else {
            // Default message for other feeds
            messageContent = `${tag} a new ${name.toLowerCase()} has been posted to the website!`;
        }

        // Send the message using the pre-calculated content
        await channel.send({ 
            content: messageContent,
            embeds: [announcementEmbed]
        });

        console.log(`[Discord] Successfully announced ${name}: "${item.title}"`);

    } catch (error) {
        console.error(`[Discord] Failed to send announcement for ${name} post "${item.title}": ${error.message}`);
    }
}

// --- 4. STARTUP AND SCHEDULER ---

client.once('clientReady', () => { 
    console.log(`🤖 Bot is online! Logged in as ${client.user.tag}`);

    // 1. Run the check immediately on start, now that the client is ready
    checkAllRssFeeds();

    // 2. Set up the interval for continuous checking
    setInterval(checkAllRssFeeds, CHECK_INTERVAL_MS);
    console.log(`[Scheduler] RSS check is scheduled every ${CHECK_INTERVAL_MS / 60000} minutes.`);
});

// Log in to Discord with your client's token
client.login(DISCORD_BOT_TOKEN);

// Optional: Graceful shutdown handling
process.on('SIGINT', () => {
    console.log('Shutting down bot...');
    client.destroy();
    process.exit(0);
});