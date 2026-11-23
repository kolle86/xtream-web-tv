const express = require("express");
const app = express();
const port = 4000;
const path = require("path");
const axios = require("axios");
const cron = require("node-cron");
const packageJson = require("./package.json");
const cors = require("cors");
var bodyParser = require("body-parser");
const dbHandler = require("./services/dbHandler"); // Import des neuen Moduls
const net = require("node:net");
const dns = require("node:dns");
const { Transform } = require("node:stream");
require("dotenv").config();
// Remove trailing slash from API URL to prevent double slashes
const apiUrl = process.env.XTREAMAPIURL?.replace(/\/+$/, "") || "";
const authEnabled = process.env.AUTH_ENABLED !== "false";
const username = process.env.XTREAMUSER;
const password = process.env.XTREAMPASSWORD;
const providerHost = (() => {
  try {
    return new URL(apiUrl).host;
  } catch {
    return "";
  }
})();
let cron_update = "15 */12 * * *";
if (process.env.CRON_UPDATE != undefined) {
  cron_update = "15 */12 * * *";
}
const session = require("express-session");
const { randomBytes } = require("node:crypto");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/bootstrap",
  express.static(path.join(__dirname, "node_modules/bootstrap/dist"))
);
app.use(
  "/icons",
  express.static(path.join(__dirname, "node_modules/bootstrap-icons/font"))
);
app.use(
  "/hls",
  express.static(path.join(__dirname, "node_modules/hls.js/dist"))
);
app.use(express.urlencoded({ extended: true })); // Middleware für Form-Daten
app.use(bodyParser.json());
app.use(cors());

const sessionSecret = randomBytes(32).toString("hex");
app.use(
  session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
  })
);

/**
 * Checks whether the current request is allowed to access protected resources.
 * @param {import("express").Request} req
 * @returns {boolean}
 */
function isLoggedIn(req) {
  return !authEnabled || Boolean(req.session.isLoggedIn);
}

/**
 * Hosts the proxy may fetch from. Starts with the configured provider and grows
 * with hosts the provider redirects to (e.g. its CDN), so segments served by a
 * different host than the playlist still work without opening an open relay.
 * @type {Set<string>}
 */
const trustedStreamHosts = new Set(providerHost ? [providerHost] : []);

/**
 * Ensures a URL points to the Xtream provider or one of its redirect targets to
 * prevent the proxy from being abused as an open relay (SSRF).
 * @param {string} urlString
 * @returns {boolean}
 */
function isAllowedStreamUrl(urlString) {
  if (typeof urlString !== "string" || urlString.length === 0) {
    return false;
  }
  try {
    const target = new URL(urlString);
    return (
      (target.protocol === "http:" || target.protocol === "https:") &&
      trustedStreamHosts.has(target.host)
    );
  } catch {
    return false;
  }
}

/**
 * Remembers the host of a URL the provider redirected to, so subsequent
 * requests for its segments are accepted.
 * @param {string} urlString
 */
function trustStreamHost(urlString) {
  try {
    trustedStreamHosts.add(new URL(urlString).host);
  } catch {
    // ignore unparsable URLs
  }
}

/**
 * Checks if an upstream response is an HLS playlist that needs URL rewriting.
 * @param {string} urlString
 * @param {string|undefined} contentType
 * @returns {boolean}
 */
function isPlaylistResponse(urlString, contentType) {
  if ((contentType || "").toLowerCase().includes("mpegurl")) {
    return true;
  }
  try {
    const pathname = new URL(urlString).pathname.toLowerCase();
    return pathname.endsWith(".m3u8") || pathname.endsWith(".m3u");
  } catch {
    return false;
  }
}

/**
 * Builds a same-origin proxy URL for an upstream resource.
 * @param {string} resourceUrl Absolute or relative upstream URL
 * @param {string} baseUrl URL of the playlist containing the resource
 * @returns {string}
 */
function toProxyUrl(resourceUrl, baseUrl) {
  const absoluteUrl = new URL(resourceUrl, baseUrl).toString();
  return `/proxy/hls?url=${encodeURIComponent(absoluteUrl)}`;
}

/**
 * Rewrites all URIs of an HLS playlist so they are loaded through this server.
 * @param {string} playlist
 * @param {string} baseUrl
 * @returns {string}
 */
function rewritePlaylist(playlist, baseUrl) {
  return playlist
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return line;
      }
      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${toProxyUrl(uri, baseUrl)}"`);
      }
      return toProxyUrl(trimmed, baseUrl);
    })
    .join("\n");
}

/**
 * Reads an upstream stream completely into a buffer.
 * @param {NodeJS.ReadableStream} stream
 * @returns {Promise<Buffer>}
 */
async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Proxies HLS playlists and segments of the Xtream provider.
 * Playlists are rewritten so every referenced resource stays on this server.
 * @route GET /proxy/hls?url=<encoded upstream url>
 */
app.get("/proxy/hls", async (req, res) => {
  if (!isLoggedIn(req)) {
    return res.status(401).send("Unauthorized");
  }
  const targetUrl = req.query.url;
  if (!isAllowedStreamUrl(targetUrl)) {
    return res.status(400).send("Invalid stream URL");
  }

  let upstream;
  try {
    upstream = await axios.get(targetUrl, {
      responseType: "stream",
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: {
        "User-Agent": req.headers["user-agent"] || "xtream-web-tv",
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
  } catch (error) {
    console.error("Stream proxy error:", error.message);
    return res.status(502).send("Error fetching stream");
  }

  // Provider redirects usually point at a CDN host that serves the segments
  const finalUrl = upstream.request?.res?.responseUrl || targetUrl;
  trustStreamHost(finalUrl);

  if (upstream.status < 200 || upstream.status >= 400) {
    upstream.data.destroy();
    console.error(`Stream proxy: upstream returned ${upstream.status} for ${finalUrl}`);
    return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
  }

  req.on("close", () => upstream.data.destroy());

  if (isPlaylistResponse(finalUrl, upstream.headers["content-type"])) {
    try {
      const body = await readStream(upstream.data);
      res.set("Cache-Control", "no-cache");
      res.type("application/vnd.apple.mpegurl").send(rewritePlaylist(body.toString("utf8"), finalUrl));
    } catch (error) {
      console.error("Error proxying playlist:", error.message);
      if (!res.headersSent) {
        res.status(502).send("Error fetching stream");
      }
    }
    return;
  }

  res.status(upstream.status);
  if (upstream.headers["content-type"]) {
    res.set("Content-Type", upstream.headers["content-type"]);
  }
  if (upstream.headers["content-range"]) {
    res.set("Content-Range", upstream.headers["content-range"]);
  }
  if (upstream.headers["accept-ranges"]) {
    res.set("Accept-Ranges", upstream.headers["accept-ranges"]);
  }
  // The body is decompressed by axios, so the encoded length no longer applies.
  if (!upstream.headers["content-encoding"] && upstream.headers["content-length"]) {
    res.set("Content-Length", upstream.headers["content-length"]);
  }

  upstream.data.on("error", () => res.destroy());
  upstream.data.pipe(res);
});

const maxImageBytes = 5 * 1024 * 1024;

/**
 * Checks whether an IP address belongs to a private, loopback or otherwise
 * internal range that must not be reachable through the image proxy.
 * @param {string} address
 * @returns {boolean}
 */
function isPrivateAddress(address) {
  if (!net.isIP(address)) {
    return true;
  }
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const ipv6 = address.toLowerCase();
  if (ipv6 === "::" || ipv6 === "::1") {
    return true;
  }
  if (ipv6.startsWith("::ffff:")) {
    return isPrivateAddress(ipv6.slice(7));
  }
  return /^f[cd][0-9a-f]{2}:/.test(ipv6) || /^fe[89ab][0-9a-f]:/.test(ipv6);
}

/**
 * DNS lookup that refuses internal targets so the image proxy cannot be used
 * to reach services on the local network.
 */
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (error, address, family) => {
    if (error) {
      return callback(error);
    }
    const addresses = Array.isArray(address) ? address : [{ address, family }];
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked) {
      return callback(new Error(`Blocked address: ${blocked.address}`));
    }
    return callback(null, address, family);
  });
}

/**
 * Proxies channel logos (picons) so http images can be shown by an https page.
 * @route GET /proxy/image?url=<encoded image url>
 */
app.get("/proxy/image", async (req, res) => {
  if (!isLoggedIn(req)) {
    return res.status(401).send("Unauthorized");
  }

  let target;
  try {
    target = new URL(req.query.url);
  } catch {
    return res.status(400).send("Invalid image URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return res.status(400).send("Invalid image URL");
  }

  // Only the provider's own host may point at the local network; everything
  // else is checked so the proxy cannot reach internal services.
  const hostIsTrusted = trustedStreamHosts.has(target.host);
  if (!hostIsTrusted) {
    // Node skips the lookup callback for literal IPs, so check them explicitly
    const hostname = target.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(hostname) && isPrivateAddress(hostname)) {
      return res.status(400).send("Invalid image URL");
    }
  }

  let upstream;
  try {
    upstream = await axios.get(target.toString(), {
      responseType: "stream",
      timeout: 15000,
      maxRedirects: 5,
      validateStatus: () => true,
      ...(hostIsTrusted
        ? {}
        : {
            lookup: safeLookup,
            // Redirect targets with a literal IP also skip the lookup callback
            beforeRedirect: (options) => {
              const hostname = String(options.hostname || "").replace(/^\[|\]$/g, "");
              if (net.isIP(hostname) && isPrivateAddress(hostname)) {
                throw new Error(`Blocked redirect to ${hostname}`);
              }
            },
          }),
      headers: {
        "User-Agent": req.headers["user-agent"] || "xtream-web-tv",
        Accept: "image/*,*/*;q=0.8",
      },
    });
  } catch (error) {
    console.error("Image proxy error:", error.message);
    return res.status(502).send("Error fetching image");
  }

  if (upstream.status < 200 || upstream.status >= 400) {
    upstream.data.destroy();
    return res.status(upstream.status).send(`Upstream returned ${upstream.status}`);
  }

  const contentType = (upstream.headers["content-type"] || "").toLowerCase();
  if (contentType && !contentType.startsWith("image/") && !contentType.startsWith("application/octet-stream")) {
    upstream.data.destroy();
    return res.status(415).send("Unsupported image type");
  }

  let received = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxImageBytes) {
        return callback(new Error("Image exceeds size limit"));
      }
      return callback(null, chunk);
    },
  });

  req.on("close", () => upstream.data.destroy());
  limiter.on("error", (error) => {
    console.error("Image proxy error:", error.message);
    upstream.data.destroy();
    res.destroy();
  });
  upstream.data.on("error", () => res.destroy());

  res.status(upstream.status);
  if (upstream.headers["content-type"]) {
    res.set("Content-Type", upstream.headers["content-type"]);
  }
  res.set("Cache-Control", "private, max-age=86400");
  upstream.data.pipe(limiter).pipe(res);
});

// Cron-Job für Updates
/**
 * Schedules a cron job to update the database tables at specified intervals.
 * The schedule is defined by the cron_update variable.
 */
cron.schedule(cron_update, () => {
  dbHandler.updateTables();
});

/**
 * Endpoint to manually trigger a database update.
 * @route GET /update
 * @returns {Object} JSON response indicating success or failure of the update.
 */
app.get("/update", async (req, res) => {
  try {
    await dbHandler.updateTables();
    res.json({ success: true, message: "Database-Update completed." });
  } catch (error) {
    res
      .status(500)
      .json({
        success: false,
        error: "Error updating database",
        details: error.message,
      });
  }
});

/**
 * Fetches the latest version of the application from GitHub releases.
 * @returns {string|null} The latest version tag or null if an error occurs.
 */
async function getLatestGitHubVersion() {
  try {
    const response = await axios.get(
      `https://api.github.com/repos/kolle86/xtream-web-tv/releases/latest`
    );
    return response.data.tag_name.replace(/^v/, "");
  } catch (error) {
    console.error("Fehler beim Abrufen der GitHub-Version:", error.message);
    return null;
  }
}

// Startseite mit Account- und Stream-Informationen
/**
 * Renders the homepage with account and stream information if the user is logged in.
 * If not logged in, renders the login page.
 * @route GET /
 */
app.get("/", async (req, res) => {
  const isLoggedIn = !authEnabled || req.session.isLoggedIn;
  if (isLoggedIn) {
    try {
      const account = await dbHandler.getAccount();
      expdate = new Date(account.user_info.exp_date * 1000);
      account.user_info.expires = expdate.toLocaleDateString("de-DE", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
      });

      const isUpToDate =
        packageJson.version === (await getLatestGitHubVersion());
      const version = {
        appVersion: packageJson.version,
        isUpToDate,
      };
      const streams = await dbHandler.getCategoriesWithStreams();
      const favourites = await dbHandler.getFavourites();
      const favouriteChannels = await dbHandler.getFavouriteChannels();
      res.render("index", {
        streams,
        apiUrl,
        username,
        password,
        account,
        version,
        favourites,
        favouriteChannels,
      });
    } catch (error) {
      console.error("Error retrieving data:", error);
      res.status(500).send("Error retrieving data.");
    }
  } else {
    res.render("login");
  }
});

/**
 * Handles user login by verifying credentials.
 * Sets session isLoggedIn to true if successful.
 * @route POST /login
 */
app.post("/login", async (req, res) => {
  if (!authEnabled) {
    return res.redirect("/");
  }
  if (req.body.password == password && req.body.username == username) {
    req.session.isLoggedIn = true;
    res.redirect("/");
  } else {
    var login_error = true;
    res.render("login", { login_error });
  }
});

/**
 * Updates the visibility of categories based on user input.
 * @route POST /bouquets
 */
app.post("/bouquets", async (req, res) => {
  console.log(req.body);
  try {
    await dbHandler.updateCategoriesVisibility(req.body.bouquetsHidden);
    res.redirect("/");
  } catch (error) {
    res.send(error);
  }
});

/**
 * Toggles a channel as favourite.
 * @route POST /favourite/toggle
 * @body {number} streamId - The stream ID to toggle as favourite.
 * @returns {Object} JSON response indicating success or failure.
 */
app.post("/favourite/toggle", async (req, res) => {
  const { streamId, isFavourite } = req.body;
  try {
    if (isFavourite) {
      await dbHandler.removeFavourite(streamId);
      res.json({ success: true, isFavourite: false });
    } else {
      await dbHandler.addFavourite(streamId);
      res.json({ success: true, isFavourite: true });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Logs the user out by destroying the session and redirects to the homepage.
 * @route GET /logout
 */
app.get("/logout", (req, res) => {
  if (!authEnabled) {
    return res.redirect("/");
  }
  req.session.destroy((err) => {
    if (err) {
      console.log(err);
    } else {
      res.redirect("/");
    }
  });
});

// Server starten
/**
 * Starts the server and listens on the specified port.
 */
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
