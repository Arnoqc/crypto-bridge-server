// Crypto News Bridge Server - Phase 1: Newsdata.io Integration
// Designed for free hosting on Glitch.com, Railway.app, or Render.com

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const CONFIG = {
  NEWSDATA_API_KEY: process.env.NEWSDATA_API_KEY || 'your_api_key_here',
  CACHE_DURATION: 30 * 60 * 1000, // 30 minutes in milliseconds
  MAX_REQUESTS_PER_DAY: 200,
  MAX_RESULTS_PER_REQUEST: 10,
  BASE_URL: 'https://newsdata.io/api/1/news'
};

// In-memory cache and request tracking
let cache = new Map();
let dailyRequestCount = 0;
let lastResetDate = new Date().toDateString();

// Middleware
app.use(cors());
app.use(express.json());

// Helper Functions
function resetDailyCountIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailyRequestCount = 0;
    lastResetDate = today;
    console.log(`[${new Date().toISOString()}] Daily request count reset`);
  }
}

function generateCacheKey(symbols, keywords, timeframe) {
  return `${symbols || 'all'}_${keywords || 'general'}_${timeframe || '24'}`;
}

function isValidCacheEntry(cacheEntry) {
  return cacheEntry && (Date.now() - cacheEntry.timestamp < CONFIG.CACHE_DURATION);
}

function formatForPineScript(articles, requestSymbols) {
  if (!articles || articles.length === 0) {
    return '';
  }

  const events = [];
  const symbolSet = requestSymbols ? new Set(requestSymbols.toUpperCase().split(',').map(s => s.trim())) : null;

  articles.forEach(article => {
    try {
      // Extract timestamp (convert to Unix timestamp for PineScript)
      const publishedDate = new Date(article.pubDate || article.published_at || Date.now());
      const timestamp = Math.floor(publishedDate.getTime() / 1000);

      // Determine relevant symbol from title/content
      let detectedSymbol = 'CRYPTO';
      if (symbolSet) {
        for (const symbol of symbolSet) {
          const regex = new RegExp(`\\b${symbol}\\b|\\b${getCoinName(symbol)}\\b`, 'i');
          if (regex.test(article.title + ' ' + (article.description || ''))) {
            detectedSymbol = symbol;
            break;
          }
        }
      }

      // Clean title (remove special characters that might break parsing)
      const cleanTitle = (article.title || 'No title')
        .replace(/[|;]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100); // Limit title length

      // Format: timestamp;CATEGORY;SYMBOL;Title
      events.push(`${timestamp};NEWS;${detectedSymbol};${cleanTitle}`);

    } catch (error) {
      console.error('Error formatting article:', error);
    }
  });

  return events.join('|');
}

function getCoinName(symbol) {
  const coinNames = {
    'BTC': 'Bitcoin',
    'ETH': 'Ethereum', 
    'ADA': 'Cardano',
    'DOT': 'Polkadot',
    'SOL': 'Solana',
    'MATIC': 'Polygon',
    'LINK': 'Chainlink',
    'UNI': 'Uniswap',
    'AAVE': 'Aave',
    'DOGE': 'Dogecoin'
  };
  return coinNames[symbol.toUpperCase()] || symbol;
}

async function fetchNewsFromAPI(symbols, keywords, timeframe) {
  resetDailyCountIfNeeded();

  // Check rate limits
  if (dailyRequestCount >= CONFIG.MAX_REQUESTS_PER_DAY) {
    throw new Error('Daily API rate limit exceeded');
  }

  // Build API URL
  const params = new URLSearchParams({
    apikey: CONFIG.NEWSDATA_API_KEY
  });

  // Build crypto search query
  let searchTerms = [];

  // Add coin symbols as search terms
  if (symbols) {
    const coinNames = symbols.split(',').map(s => {
      const symbol = s.trim().toUpperCase();
      const coinName = getCoinName(symbol);
      return `${symbol} OR ${coinName}`;
    });
    searchTerms.push(...coinNames);
  }

  // Add keywords
  if (keywords) {
    searchTerms.push(keywords);
  }

  // Add general crypto terms if no specific search
  if (searchTerms.length === 0) {
    searchTerms.push('cryptocurrency OR bitcoin OR crypto OR blockchain');
  }

  params.append('q', searchTerms.join(' OR '));
  params.append('category', 'business,technology');

  // Add timeframe (default to 24 hours)
  const timeframeHours = timeframe || '24';
  params.append('timeframe', timeframeHours);

  // Add language filter
  params.append('language', 'en');

  const url = `${CONFIG.BASE_URL}?${params.toString()}`;
  
  console.log(`[${new Date().toISOString()}] Fetching from API: ${url.replace(CONFIG.NEWSDATA_API_KEY, 'API_KEY_HIDDEN')}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'CryptoBridgeServer/1.0'
      },
      timeout: 10000 // 10 second timeout
    });

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json();
    dailyRequestCount++;

    console.log(`[${new Date().toISOString()}] API Success. Articles: ${data.results?.length || 0}, Requests today: ${dailyRequestCount}`);

    return data.results || [];

  } catch (error) {
    console.error(`[${new Date().toISOString()}] API Error:`, error.message);
    throw error;
  }
}

// Routes

// Health check endpoint
app.get('/health', (req, res) => {
  resetDailyCountIfNeeded();
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    dailyRequests: dailyRequestCount,
    remainingRequests: CONFIG.MAX_REQUESTS_PER_DAY - dailyRequestCount,
    cacheEntries: cache.size
  });
});

// Main crypto news endpoint for PineScript
app.get('/crypto-news', async (req, res) => {
  try {
    const { symbols, keywords, timeframe } = req.query;
    
    // Input validation
    if (symbols && symbols.split(',').length > 5) {
      return res.status(400).json({ 
        error: 'Maximum 5 symbols allowed' 
      });
    }

    // Generate cache key
    const cacheKey = generateCacheKey(symbols, keywords, timeframe);
    
    // Check cache first
    const cachedData = cache.get(cacheKey);
    if (isValidCacheEntry(cachedData)) {
      console.log(`[${new Date().toISOString()}] Cache hit for key: ${cacheKey}`);
      return res.type('text/plain').send(cachedData.data);
    }

    // Fetch from API
    let articles;
    try {
      articles = await fetchNewsFromAPI(symbols, keywords, timeframe);
    } catch (apiError) {
      // If API fails and we have old cached data, use it
      if (cachedData && cachedData.data) {
        console.log(`[${new Date().toISOString()}] API failed, serving stale cache for key: ${cacheKey}`);
        return res.type('text/plain').send(cachedData.data);
      }
      
      // No cache available, return error
      console.error(`[${new Date().toISOString()}] API failed with no cache backup:`, apiError.message);
      return res.status(503).json({ 
        error: 'News service temporarily unavailable',
        details: apiError.message 
      });
    }

    // Format data for PineScript
    const formattedData = formatForPineScript(articles, symbols);
    
    // Update cache
    cache.set(cacheKey, {
      data: formattedData,
      timestamp: Date.now()
    });

    // Clean old cache entries (keep cache size manageable)
    if (cache.size > 50) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }

    console.log(`[${new Date().toISOString()}] Served fresh data for key: ${cacheKey}, events: ${formattedData.split('|').length}`);
    
    // Return formatted data as plain text for PineScript
    res.type('text/plain').send(formattedData);

  } catch (error) {
    console.error(`[${new Date().toISOString()}] Endpoint error:`, error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message 
    });
  }
});

// Debug endpoint to see raw API response
app.get('/debug', async (req, res) => {
  try {
    const { symbols, keywords, timeframe } = req.query;
    const articles = await fetchNewsFromAPI(symbols, keywords, timeframe);
    
    res.json({
      requestParams: { symbols, keywords, timeframe },
      articleCount: articles.length,
      articles: articles.slice(0, 3), // Show first 3 articles
      formatted: formatForPineScript(articles, symbols)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cache management endpoint
app.get('/cache', (req, res) => {
  const cacheStats = Array.from(cache.entries()).map(([key, value]) => ({
    key,
    age: Math.floor((Date.now() - value.timestamp) / 1000 / 60) + ' minutes',
    dataLength: value.data.length
  }));

  res.json({
    totalEntries: cache.size,
    entries: cacheStats
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Unhandled error:`, error);
  res.status(500).json({ 
    error: 'Server error',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    availableEndpoints: ['/health', '/crypto-news', '/debug', '/cache']
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Crypto Bridge Server running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Cache duration: ${CONFIG.CACHE_DURATION / 60000} minutes`);
  console.log(`[${new Date().toISOString()}] Daily request limit: ${CONFIG.MAX_REQUESTS_PER_DAY}`);
});

module.exports = app;