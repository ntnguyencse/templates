// IMPORTANT: Either A Key/Value Namespace must be bound to this worker script
// using the variable name EDGE_CACHE. or the API parameters below should be
// configured. KV is recommended if possible since it can purge just the HTML
// instead of the full cache.

// API settings if KV isn't being used
const CLOUDFLARE_API = {
  email: "", // From https://dash.cloudflare.com/profile
  key: "",   // Global API Key from https://dash.cloudflare.com/profile
  zone: ""   // "Zone ID" from the API section of the dashboard overview page https://dash.cloudflare.com/
};

/**
 * Main worker entry point. 
 */
addEventListener("fetch", event => {
  const request = event.request;
  let upstreamCache = request.headers.get('x-HTML-Edge-Cache');

  // Only process requests if KV store is set up and there is no
  // HTML edge cache in front of this worker (only the outermost cache
  // should handle HTML caching in case there are varying levels of support).
  let configured = false;
  if (typeof EDGE_CACHE !== 'undefined') {
    configured = true;
  } else if (CLOUDFLARE_API.email.length && CLOUDFLARE_API.key.length && CLOUDFLARE_API.zone.length) {
    configured = true;
  }
  if ( configured && upstreamCache === null) {
    event.passThroughOnException();
    event.respondWith(processRequest(request, event));
  }
});

/**
 * Process every request coming through to add the edge-cache header,
 * watch for purge responses and possibly cache HTML GET requests.
 * 
 * @param {Request} originalRequest - Original request
 * @param {Event} event - Original event (for additional async waiting)
 */
async function processRequest(originalRequest, event) {
  let {response, cacheVer, status} = await getCachedResponse(originalRequest);

  if (response === null) {
    // Clone the request, add the edge-cache header and send it through.
    let request = new Request(originalRequest);
    request.headers.set('x-HTML-Edge-Cache', 'supports=cache|purgeall|bypass-cookies');
    response = await fetch(request);

    if (response) {
      const options = getResponseOptions(response);
      if (options.purge) {
        await purgeCache(cacheVer, event);
        status += ', Purged';
      }
      if (options.cache) {
        status += await cacheResponse(cacheVer, originalRequest, response, event);
      }
    }
  }

  const accept = originalRequest.headers.get('Accept');
  if (response && status !== null && originalRequest.method === 'GET' && response.status === 200 && accept && accept.indexOf('text/html') >= 0) {
    response = new Response(response.body, response);
    response.headers.set('x-HTML-Edge-Cache-Status', status);
    if (cacheVer !== null) {
      response.headers.set('x-HTML-Edge-Cache-Version', cacheVer.toString());
    }
  }

  return response;
}

const CACHE_HEADERS = ['Cache-Control', 'Expires', 'Pragma'];

/**
 * Check for cached HTML GET requests.
 * 
 * @param {Request} request - Original request
 */
async function getCachedResponse(request) {
  let response = null;
  let cacheVer = null;
  let status = 'Bypass';

  // Only check for HTML GET requests (saves on reading from KV unnecessarily)
  // and not when there are cache-control headers on the request (refresh)
  const accept = request.headers.get('Accept');
  const cacheControl = request.headers.get('Cache-Control');
  if (cacheControl === null && request.method === 'GET' && accept && accept.indexOf('text/html') >= 0) {
    // Build the versioned URL for checking the cache
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);

    // See if there is a request match in the cache
    try {
      let cache = caches.default;
      let cachedResponse = await cache.match(cacheKeyRequest);
      if (cachedResponse) {
        let bypassCache = false;

        // Copy Response object so that we can edit headers.
        cachedResponse = new Response(cachedResponse.body, cachedResponse);

        // Check to see if the response needs to be skipped for a login cookie.
        const options = getResponseOptions(cachedResponse);
        const cookieHeader = request.headers.get('cookie');
        if (cookieHeader && cookieHeader.length && options.bypassCookies.length) {
          const cookies = cookieHeader.split(';');
          for (let cookie of cookies) {
            // See if the cookie starts with any of the logged-in user prefixes
            for (let prefix of options.bypassCookies) {
              if (cookie.trim().startsWith(prefix)) {
                bypassCache = true;
                break;
              }
            }
            if (bypassCache) {
              break;
            }
          }
        }
      
        // Copy the original cache headers back and clean up any control headers
        if (bypassCache) {
          status = 'Bypass Cookie';
        } else {
          status = 'Hit';
          response = cachedResponse;
          response.headers.delete('x-HTML-Edge-Cache');
          response.headers.delete('Cache-Control');
          for (header of CACHE_HEADERS) {
            let value = response.headers.get('x-HTML-Edge-Cache-' + header);
            if (value) {
              response.headers.delete('x-HTML-Edge-Cache-' + header);
              response.headers.set(header, value);
            }
          }
        }
      } else {
        status = 'Miss';
      }
    } catch (err) {
      // Send the exception back in the response header for debugging
      status = "Cache Read Exception: " + err.message;
    }
  }

  return {response, cacheVer, status};
}

/**
 * Asynchronously purge the HTML cache.
 * @param {Int} cacheVer - Current cache version (if retrieved)
 * @param {Event} event - Original event
 */
async function purgeCache(cacheVer, event) {
  if (typeof EDGE_CACHE !== 'undefined') {
    // Purge the KV cache by bumping the version number
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    cacheVer++;
    event.waitUntil(EDGE_CACHE.put('html_cache_version', cacheVer.toString()));
  } else {
    // Purge everything using the API
    const url = "https://api.cloudflare.com/client/v4/zones/" + CLOUDFLARE_API.zone + "/purge_cache";
    event.waitUntil(fetch(url,{
      method: 'POST',
      headers: {'X-Auth-Email': CLOUDFLARE_API.email,
                'X-Auth-Key': CLOUDFLARE_API.key,
                'Content-Type': 'application/json'},
      body: JSON.stringify({purge_everything: true})
    }));
  }
}

/**
 * Cache the returned content (but only if it was a successful GET request)
 * 
 * @param {Int} cacheVer - Current cache version (if already retrieved)
 * @param {Request} request - Original Request
 * @param {Response} originalResponse - Response to (maybe) cache
 * @param {Event} event - Original event
 * @returns {bool} true if the response was cached
 */
async function cacheResponse(cacheVer, request, originalResponse, event) {
  let status = "";
  const accept = request.headers.get('Accept');
  if (request.method === 'GET' && originalResponse.status === 200 && accept && accept.indexOf('text/html') >= 0) {
    cacheVer = await GetCurrentCacheVersion(cacheVer);
    const cacheKeyRequest = GenerateCacheRequest(request, cacheVer);

    try {
      // Move the cache headers out of the way so the response can actually be cached.
      // First clone the response so there is a parallel body stream and then
      // create a new response object based on the clone that we can edit.
      let cache = caches.default;
      let clonedResponse = originalResponse.clone();
      let response = new Response(clonedResponse.body, clonedResponse);
      for (header of CACHE_HEADERS) {
        let value = response.headers.get(header);
        if (value) {
          response.headers.delete(header);
          response.headers.set('x-HTML-Edge-Cache-' + header, value);
        }
      }
      response.headers.delete('Set-Cookie');
      response.headers.set('Cache-Control', 'public; max-age=315360000');
      event.waitUntil(cache.put(cacheKeyRequest, response));
      status = ", Cached";
    } catch (err) {
      // Send the exception back in the response header for debugging
      status = ", Cache Write Exception: " + err.message;
    }
  }
  return status;
}

/******************************************************************************
 * Utility Functions
 *****************************************************************************/

/**
 * Parse the commands from the x-HTML-Edge-Cache response header.
 * @param {Response} response - HTTP response from the origin.
 * @returns {*} Parsed commands
 */
function getResponseOptions(response) {
  let options = {
    purge: false,
    cache: false,
    bypassCookies: []
  };

  let header = response.headers.get('x-HTML-Edge-Cache');
  if (header) {
    let commands = header.split(',');
    for (let command of commands) {
      if (command.trim() === 'purgeall') {
        options.purge = true;
      } else if (command.trim() === 'cache') {
        options.cache = true;
      } else if (command.trim().startsWith('bypass-cookies')) {
        let separator = command.indexOf('=');
        if (separator >= 0) {
          let cookies = command.substr(separator + 1).split('|');
          for (let cookie of cookies) {
            cookie = cookie.trim();
            if (cookie.length) {
              options.bypassCookies.push(cookie);
            }
          }
        }
      }
    }
  }

  return options;
}

/**
 * Retrieve the current cache version from KV
 * @param {Int} cacheVer - Current cache version value if set.
 * @returns {Int} The current cache version.
 */
async function GetCurrentCacheVersion(cacheVer) {
  if (cacheVer === null) {
    if (typeof EDGE_CACHE !== 'undefined') {
      cacheVer = await EDGE_CACHE.get('html_cache_version');
      if (cacheVer === null) {
        // Uninitialized - first time through, initialize KV with a value
        // Blocking but should only happen immediately after worker activation.
        cacheVer = 0;
        await EDGE_CACHE.put('html_cache_version', cacheVer.toString());
      } else {
        cacheVer = parseInt(cacheVer);
      }
    } else {
      cacheVer = -1;
    }
  }
  return cacheVer;
}

/**
 * Generate the versioned Request object to use for cache operations.
 * @param {Request} request - Base request
 * @param {Int} cacheVer - Current Cache version (must be set)
 * @returns {Request} Versioned request object
 */
function GenerateCacheRequest(request, cacheVer) {
  let cacheUrl = request.url;
  if (cacheUrl.indexOf('?') >= 0) {
    cacheUrl += '&';
  } else {
    cacheUrl += '?';
  }
  cacheUrl += 'cf_edge_cache_ver=' + cacheVer;
  return new Request(cacheUrl);
}
