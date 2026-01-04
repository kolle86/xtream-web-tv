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
require("dotenv").config();
// Remove trailing slash from API URL to prevent double slashes
const apiUrl = process.env.XTREAMAPIURL?.replace(/\/+$/, "") || "";
const username = process.env.XTREAMUSER;
const password = process.env.XTREAMPASSWORD;
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
  const isLoggedIn = req.session.isLoggedIn;
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
