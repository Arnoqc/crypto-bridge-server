// Crypto News Bridge Server - Complete Phase 2: Newsdata.io + Arkham Integration
// All bugs fixed, ready for production deployment

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
  BASE_URL: 'https://newsdata.io/api/1/news' // FIXED: Using regular news endpoint
};

// In-memory cache and request tracking
let cache = new Map();
let dailyRequestCount = 0;
let lastResetDate = new Date().toDateString();

// In-memory storage for Arkham webhook events
let arkhamEvents = [];
const MAX_ARKHAM_EVENTS = 100; // Keep last 100 events

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase limit for webhook payloads

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
    'DOGE': 'Dogecoin',
    'XRP': 'Ripple',
    'LTC': 'Litecoin',
    'BCH': 'Bitcoin Cash',
    'DOT': 'Polkadot',
    'AVAX': 'Avalanche'
  };
  return coinNames[symbol.toUpperCase()] || symbol;
}

// Arkham webhook event processing
function processArkhamEvent(webhookData) {
  try {
    // Extract key information from Arkham webhook
    const timestamp = Math.floor(Date.now() / 1000); // Current timestamp
    
    // Try to extract relevant data from webhook (format may vary)
    let symbol = 'CRYPTO';
    let title = 'On-chain activity detected';
    let amount = '';
    
    // Parse different possible webhook formats
    if (webhookData.transaction) {
      const tx = webhookData.transaction;
      
      // Try to detect token/coin from transaction data
      if (tx.token) {
        symbol = tx.token.toUpperCase();
      } else if (tx.asset) {
        symbol = tx.asset.toUpperCase();
      } else if (tx.symbol) {
        symbol = tx.symbol.toUpperCase();
      }
      
      // Format transaction details
      if (tx.value) {
        const value = parseFloat(tx.value);
        if (value > 1000000) { // >$1M
          amount = `$${(value / 1000000).toFixed(1)}M`;
          title = `Large ${symbol} transfer: ${amount}`;
        } else if (value > 1000) {
          amount = `$${(value / 1000).toFixed(0)}K`;
          title = `${symbol} transfer: ${amount}`;
        } else {
          title = `${symbol} movement detected`;
        }
      }
    }
    
    // Fallback parsing for different webhook structures
    if (!title || title === 'On-chain activity detected') {
      if (webhookData.alert && webhookData.alert.name) {
        title = webhookData.alert.name;
      } else if (webhookData.description) {
        title = webhookData.description.substring(0, 100);
      } else if (webhookData.message) {
        title = webhookData.message.substring(0, 100);
      }
    }
    
    // Clean title - remove special characters that could break PineScript parsing
    title = title.replace(/[|;]/g, ' ').replace(/\s+/g, ' ').trim();
    
    return {
      timestamp,
      category: 'ONCHAIN',
      symbol,
      title,
      amount,
      raw: webhookData // Store raw data for debugging
    };
    
  } catch (error) {
    console.error('Error processing Arkham webhook:', error);
    return null;
  }
}

function addArkhamEvent(event) {
  if (event) {
    arkhamEvents.unshift(event); // Add to beginning
    
    // Keep only the latest events
    if (arkhamEvents.length > MAX_ARKHAM_EVENTS) {
      arkhamEvents = arkhamEvents.slice(0, MAX_ARKHAM_EVENTS);
    }
    
    console.log(`[${new Date().toISOString()}] New Arkham event: ${event.symbol} - ${event.title}`);
  }
}

function getRecentArkhamEvents(hoursBack = 24) {
  const cutoffTime = Math.floor(Date.now() / 1000) - (hoursBack * 3600);
  return arkhamEvents.filter(event => event.timestamp > cutoffTime);
}

function formatForPineScript(articles, requestSymbols, includeArkham = true) {
  const events = [];
  const symbolSet = requestSymbols ? new Set(requestSymbols.toUpperCase().split(',').map(s => s.trim())) : null;

  // Add news articles
  if (articles && articles.length > 0) {
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
  }

  // Add recent Arkham events
  if (includeArkham) {
    const recentArkhamEvents = getRecentArkhamEvents(24);
    
    recentArkhamEvents.forEach(arkhamEvent => {
      try {
        // Filter by symbol if requested
        if (symbolSet && !symbolSet.has(arkhamEvent.symbol) && arkhamEvent.symbol !== 'CRYPTO') {
          return; // Skip this event if it doesn't match requested symbols
        }

        // Format: timestamp;CATEGORY;SYMBOL;Title
        events.push(`${arkhamEvent.timestamp};ONCHAIN;${arkhamEvent.symbol};${arkhamEvent.title}`);
      } catch (error) {
        console.error('Error formatting Arkham event:', error);
      }
    });
  }

  // Sort all events by timestamp (newest first)
  events.sort((a, b) => {
    const timestampA = parseInt(a.split(';')[0]);
    const timestampB = parseInt(b.split(';')[0]);
    return timestampB - timestampA;
  });

  return events.join('|');
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

  // FIXED: Add date filtering (regular news endpoint uses 'from' instead of 'timeframe')
  if (timeframe) {
    const hoursAgo = parseInt(timeframe) || 24;
    const fromDate = new Date(Date.now() - (hoursAgo * 60 * 60 * 1000));
    const dateString = fromDate.toISOString().split('T')[0]; // Format: YYYY-MM-DD
    params.append('from', dateString);
  }

  // Add language filter
  params.append('language', 'en');

  const url = `${CONFIG.BASE_URL}?${params.toString()}`;
  
  console.log(`[${new Date().toISOString()}] Fetching from API: ${url.replace(CONFIG.NEWSDATA_API_KEY, 'API_KEY_HIDDEN')}`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'CryptoBridgeServer/2.0'
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
    version: '2.0',
    dailyRequests: dailyRequestCount,
    remainingRequests: CONFIG.MAX_REQUESTS_PER_DAY - dailyRequestCount,
    cacheEntries: cache.size,
    arkhamEvents: arkhamEvents.length,
    features: ['news', 'arkham-webhooks', 'symbol-detection', 'caching']
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
      // Even with cached news, include fresh Arkham events
      const cachedArticles = JSON.parse(cachedData.articles || '[]');
      const formattedData = formatForPineScript(cachedArticles, symbols, true);
      return res.type('text/plain').send(formattedData || '');
    }

    // Fetch from API
    let articles;
    try {
      articles = await fetchNewsFromAPI(symbols, keywords, timeframe);
    } catch (apiError) {
      // If API fails and we have old cached data, use it
      if (cachedData && cachedData.articles) {
        console.log(`[${new Date().toISOString()}] API failed, serving stale cache for key: ${cacheKey}`);
        const cachedArticles = JSON.parse(cachedData.articles || '[]');
        const formattedData = formatForPineScript(cachedArticles, symbols, true);
        return res.type('text/plain').send(formattedData || '');
      }
      
      // No cache available, but still return Arkham events if available
      console.error(`[${new Date().toISOString()}] API failed with no cache backup:`, apiError.message);
      const formattedData = formatForPineScript([], symbols, true);
      if (formattedData) {
        return res.type('text/plain').send(formattedData);
      }
      
      return res.status(503).json({ 
        error: 'News service temporarily unavailable',
        details: apiError.message 
      });
    }

    // Format data for PineScript (includes both news and Arkham events)
    const formattedData = formatForPineScript(articles, symbols, true);
    
    // Update cache
    cache.set(cacheKey, {
      data: formattedData,
      articles: JSON.stringify(articles),
      timestamp: Date.now()
    });

    // Clean old cache entries (keep cache size manageable)
    if (cache.size > 50) {
      const oldestKey = cache.keys().next().value;
      cache.delete(oldestKey);
    }

    const eventCount = formattedData ? formattedData.split('|').length : 0;
    console.log(`[${new Date().toISOString()}] Served fresh data for key: ${cacheKey}, events: ${eventCount}`);
    
    // Return formatted data as plain text for PineScript
    res.type('text/plain').send(formattedData || '');

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
    const recentArkhamEvents = getRecentArkhamEvents(24);
    
    res.json({
      requestParams: { symbols, keywords, timeframe },
      newsArticleCount: articles.length,
      arkhamEventCount: recentArkhamEvents.length,
      articles: articles.slice(0, 3), // Show first 3 articles
      arkhamEvents: recentArkhamEvents.slice(0, 3), // Show first 3 Arkham events
      formatted: formatForPineScript(articles, symbols, true)
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      arkhamEvents: getRecentArkhamEvents(24).slice(0, 3)
    });
  }
});

// Cache management endpoint
app.get('/cache', (req, res) => {
  const cacheStats = Array.from(cache.entries()).map(([key, value]) => ({
    key,
    age: Math.floor((Date.now() - value.timestamp) / 1000 / 60) + ' minutes',
    dataLength: value.data ? value.data.length : 0
  }));

  res.json({
    totalEntries: cache.size,
    entries: cacheStats
  });
});

// Arkham webhook endpoint (for real Arkham alerts)
app.post('/arkham-webhook', (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Arkham webhook received:`, JSON.stringify(req.body, null, 2));
    
    // Process the webhook data
    const event = processArkhamEvent(req.body);
    
    if (event) {
      addArkhamEvent(event);
      res.status(200).json({ 
        success: true, 
        message: 'Webhook processed successfully',
        event: {
          symbol: event.symbol,
          title: event.title,
          timestamp: event.timestamp
        }
      });
    } else {
      console.log(`[${new Date().toISOString()}] Failed to process webhook data`);
      res.status(400).json({ 
        success: false, 
        message: 'Could not process webhook data' 
      });
    }
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Webhook error:`, error);
    res.status(500).json({ 
      success: false, 
      message: 'Internal webhook processing error' 
    });
  }
});

// Arkham events endpoint (for debugging)
app.get('/arkham-events', (req, res) => {
  const { hours } = req.query;
  const hoursBack = parseInt(hours) || 24;
  const events = getRecentArkhamEvents(hoursBack);
  
  res.json({
    totalEvents: arkhamEvents.length,
    recentEvents: events.length,
    hoursBack,
    events: events.map(e => ({
      timestamp: e.timestamp,
      symbol: e.symbol,
      title: e.title,
      age: Math.floor((Date.now() / 1000 - e.timestamp) / 60) + ' minutes ago'
    }))
  });
});

// Test webhook endpoint - POST version (for real webhook testing)
app.post('/test-webhook', (req, res) => {
  // Simulate an Arkham webhook for testing
  const testEvent = {
    transaction: {
      value: 5000000, // $5M
      token: 'BTC',
      from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
    },
    alert: {
      name: 'Large BTC Transfer Alert'
    }
  };
  
  const event = processArkhamEvent(testEvent);
  if (event) {
    addArkhamEvent(event);
    res.json({ success: true, testEvent: event });
  } else {
    res.status(400).json({ success: false, message: 'Failed to process test event' });
  }
});

// Test webhook endpoint - GET version (for browser testing)
app.get('/test-webhook', (req, res) => {
  // Simulate an Arkham webhook for testing
  const testEvent = {
    transaction: {
      value: 5000000, // $5M
      token: 'BTC',
      from: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      to: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'
    },
    alert: {
      name: 'Large BTC Transfer Alert'
    }
  };
  
  const event = processArkhamEvent(testEvent);
  if (event) {
    addArkhamEvent(event);
    res.json({ 
      success: true, 
      message: 'Test event created successfully',
      testEvent: event,
      instructions: 'Check /arkham-events to see stored events, and /crypto-news?symbols=BTC to see it in the feed'
    });
  } else {
    res.status(400).json({ success: false, message: 'Failed to process test event' });
  }
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
    availableEndpoints: [
      '/health', 
      '/crypto-news', 
      '/debug', 
      '/cache', 
      '/arkham-webhook', 
      '/arkham-events', 
      '/test-webhook'
    ]
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Crypto Bridge Server v2.0 running on port ${PORT}`);
  console.log(`[${new Date().toISOString()}] Cache duration: ${CONFIG.CACHE_DURATION / 60000} minutes`);
  console.log(`[${new Date().toISOString()}] Daily request limit: ${CONFIG.MAX_REQUESTS_PER_DAY}`);
  console.log(`[${new Date().toISOString()}] Arkham webhook endpoint: /arkham-webhook`);
  console.log(`[${new Date().toISOString()}] Test webhook: GET/POST /test-webhook`);
});

module.exports = app;