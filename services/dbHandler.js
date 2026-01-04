const axios = require("axios");
const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./data/xtream.db");
require("dotenv").config();

// Remove trailing slash from API URL to prevent double slashes
const apiUrl = process.env.XTREAMAPIURL?.replace(/\/+$/, "") || "";
const username = process.env.XTREAMUSER;
const password = process.env.XTREAMPASSWORD;

//Create tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_id INTEGER,
        name TEXT NOT NULL
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id INTEGER,
        name TEXT NOT NULL,
        icon TEXT,
        category_id INTEGER,
        num INTEGER,
        FOREIGN KEY (category_id) REFERENCES categories(category_id) ON DELETE CASCADE
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS categories_visibility (
        category_id INTEGER PRIMARY KEY,
        hidden INTEGER,
        FOREIGN KEY (category_id) REFERENCES categories(category_id) 
    )`);

  db.run(`CREATE TABLE IF NOT EXISTS favourites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_id INTEGER UNIQUE,
        added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (stream_id) REFERENCES channels(stream_id)
    )`);
  checkAndUpdateTables();
});

/**
 * Checks if the categories table is empty and updates tables if necessary.
 */
function checkAndUpdateTables() {
  db.get("SELECT COUNT(*) AS count FROM categories", (err, row) => {
    if (err) {
      console.error("Fehler bei der Abfrage:", err.message);
      return;
    }
    if (row.count === 0) {
      console.log("Table categories is empty.");
      updateTables();
    }
  });
}

/**
 * Cleans up favourites by removing entries for streams that no longer exist.
 * @returns {Promise<void>} A promise that resolves when cleanup is complete.
 */
function cleanupFavourites() {
  return new Promise((resolve, reject) => {
    console.log("Cleaning up dead favourites...");
    db.run(
      `DELETE FROM favourites WHERE stream_id NOT IN (SELECT stream_id FROM channels)`,
      function (err) {
        if (err) {
          console.error("Error cleaning up favourites:", err.message);
          reject(err);
          return;
        }
        console.log(`Removed ${this.changes} dead favourites.`);
        resolve();
      }
    );
  });
}

/**
 * Updates the database tables by clearing existing data and fetching new streams.
 * @returns {Promise<void>} A promise that resolves when the tables are updated.
 */
function updateTables() {
  return new Promise((resolve, reject) => {
    console.log("Updating database...");

    db.serialize(() => {
      db.run("DELETE FROM channels");
      db.run("DELETE FROM categories", (err) => {
        if (err) {
          console.error("Fehler beim Leeren der Tabellen:", err.message);
          reject(err);
          return;
        }
        console.log("Truncated tables...");
        getStreams()
          .then(() => cleanupFavourites())
          .then(resolve)
          .catch(reject);
      });
    });
  });
}

/**
 * Fetches account information from the API.
 * @returns {Promise<Object>} A promise that resolves to the account data.
 */
const getAccount = async () => {
  try {
    const account = await axios.get(
      `${apiUrl}/player_api.php?username=${username}&password=${password}`,
      { timeout: 30000 } // 30 second timeout
    );
    return account.data;
  } catch (error) {
    console.error("Error fetching account info:", error.code || error.message);
    throw error;
  }
};

// Streams by categorie
/**
 * Fetches streams for a specific category from the API.
 * @param {number} category_id - The ID of the category to fetch streams for.
 * @param {number} retries - Number of retry attempts (default: 3)
 * @param {number} delay - Delay between retries in ms (default: 2000)
 * @returns {Promise<Array>} A promise that resolves to the streams data.
 */
const getStreamsByCategory = async (category_id, retries = 3, delay = 2000) => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const streams = await axios.get(
        `${apiUrl}/player_api.php?username=${username}&password=${password}&action=get_live_streams&category_id=${category_id}`,
        { timeout: 30000 } // 30 second timeout
      );
      return streams.data;
    } catch (error) {
      if (attempt === retries) {
        console.error(
          `Error fetching streams for category ${category_id} after ${retries} attempts:`,
          error.code || error.message
        );
        return []; // Return empty array instead of throwing
      }
      console.warn(
        `Attempt ${attempt}/${retries} failed for category ${category_id}, retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return [];
};

/**
 * Fetches all categories and their streams from the API and updates the database.
 * @returns {Promise<Array>} A promise that resolves to the categories data.
 */
const getStreams = async () => {
  try {
    const categoriesResponse = await axios.get(
      `${apiUrl}/player_api.php?username=${username}&password=${password}&action=get_live_categories`,
      { timeout: 30000 } // 30 second timeout
    );
    const categories = categoriesResponse.data;

    // Start transaction for better performance
    await new Promise((resolve, reject) => {
      db.run("BEGIN TRANSACTION", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    try {
      // Prepare statements outside the loop for better performance
      const categoryStmt = db.prepare(
        "INSERT INTO categories (category_id, name) VALUES (?, ?)"
      );
      const channelStmt = db.prepare(
        "INSERT INTO channels (stream_id, name, icon, num, category_id) VALUES (?, ?, ?, ?, ?)"
      );

      for (const category of categories) {
        console.log("Inserting " + category.category_name + "...");

        try {
          await new Promise((resolve, reject) => {
            categoryStmt.run(
              [category.category_id, category.category_name],
              function (err) {
                if (err) {
                  console.log(err.message);
                  return reject(err);
                }
                resolve();
              }
            );
          });

          const streams = await getStreamsByCategory(category.category_id);

          // Only process if we have streams
          if (streams && streams.length > 0) {
            for (const stream of streams) {
              await new Promise((resolve, reject) => {
                channelStmt.run(
                  [
                    stream.stream_id,
                    stream.name,
                    stream.stream_icon,
                    stream.num,
                    category.category_id,
                  ],
                  function (err) {
                    if (err) {
                      console.log(err.message);
                      return reject(err);
                    }
                    resolve();
                  }
                );
              });
            }
          } else {
            console.warn(
              `No streams found for category ${category.category_name}`
            );
          }
        } catch (categoryError) {
          console.error(
            `Failed to process category ${category.category_name}:`,
            categoryError.message
          );
          // Continue with next category instead of failing completely
          continue;
        }
      }

      // Finalize prepared statements
      await new Promise((resolve, reject) => {
        categoryStmt.finalize((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise((resolve, reject) => {
        channelStmt.finalize((err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Commit transaction
      await new Promise((resolve, reject) => {
        db.run("COMMIT", (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    } catch (error) {
      // Rollback on error
      await new Promise((resolve) => {
        db.run("ROLLBACK", () => resolve());
      });
      throw error;
    }
    return categories;
  } catch (error) {
    console.error("Error fetching streams:", error);
    return [];
  }
};

/**
 * Retrieves categories with their associated streams from the database.
 * @returns {Promise<Array>} A promise that resolves to the categories with streams.
 */
async function getCategoriesWithStreams() {
  return new Promise((resolve, reject) => {
    db.all(
      "SELECT categories.*, categories_visibility.hidden FROM categories LEFT JOIN categories_visibility ON categories.category_id = categories_visibility.category_id ORDER BY id ASC",
      async (err, categories) => {
        if (err) return reject(err);
        try {
          //console.log(categories)
          const categoryPromises = categories.map((category) => {
            return new Promise((resolve, reject) => {
              db.all(
                "SELECT * FROM channels WHERE category_id = ? ORDER BY num ASC",
                [category.category_id],
                (err, channels) => {
                  if (err) return reject(err);
                  category.streams = channels;
                  resolve(category);
                }
              );
            });
          });
          const results = await Promise.all(categoryPromises);
          resolve(results);
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}

/**
 * Updates the visibility of categories in the database.
 * @param {Array<number>} bouquetsHidden - An array of category IDs to hide.
 * @returns {Promise<void>} A promise that resolves when the visibility is updated.
 */
async function updateCategoriesVisibility(bouquetsHidden) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run("DELETE FROM categories_visibility", (err) => {
        if (err) {
          console.error("Error clearing table:", err.message);
          return reject(err);
        }
      });

      const stmt = db.prepare(
        "INSERT INTO categories_visibility (category_id, hidden) VALUES (?, 1)"
      );
      bouquetsHidden.forEach((categoryId) => {
        stmt.run(categoryId, (err) => {
          if (err) {
            console.error(
              `Error inserting category_id ${categoryId}:`,
              err.message
            );
          }
        });
      });
      stmt.finalize((err) => {
        if (err) {
          console.error("Error finalizing statement:", err.message);
          return reject(err);
        }
        resolve();
      });
    });
  });
}

/**
 * Adds a channel to favourites.
 * @param {number} streamId - The stream ID to add to favourites.
 * @returns {Promise<void>} A promise that resolves when the favourite is added.
 */
function addFavourite(streamId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT OR IGNORE INTO favourites (stream_id) VALUES (?)",
      [streamId],
      function (err) {
        if (err) {
          console.error("Error adding favourite:", err.message);
          reject(err);
          return;
        }
        resolve({ added: this.changes > 0 });
      }
    );
  });
}

/**
 * Removes a channel from favourites.
 * @param {number} streamId - The stream ID to remove from favourites.
 * @returns {Promise<void>} A promise that resolves when the favourite is removed.
 */
function removeFavourite(streamId) {
  return new Promise((resolve, reject) => {
    db.run(
      "DELETE FROM favourites WHERE stream_id = ?",
      [streamId],
      function (err) {
        if (err) {
          console.error("Error removing favourite:", err.message);
          reject(err);
          return;
        }
        resolve({ removed: this.changes > 0 });
      }
    );
  });
}

/**
 * Gets all favourite stream IDs.
 * @returns {Promise<Array>} A promise that resolves to an array of favourite stream IDs.
 */
function getFavourites() {
  return new Promise((resolve, reject) => {
    db.all("SELECT stream_id FROM favourites", (err, rows) => {
      if (err) {
        console.error("Error getting favourites:", err.message);
        reject(err);
        return;
      }
      resolve(rows.map((row) => row.stream_id));
    });
  });
}

/**
 * Gets all favourite channels with full details.
 * @returns {Promise<Array>} A promise that resolves to an array of favourite channels.
 */
function getFavouriteChannels() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT channels.* FROM channels 
       INNER JOIN favourites ON channels.stream_id = favourites.stream_id
       ORDER BY channels.name COLLATE NOCASE ASC`,
      (err, rows) => {
        if (err) {
          console.error("Error getting favourite channels:", err.message);
          reject(err);
          return;
        }
        resolve(rows);
      }
    );
  });
}

module.exports = {
  getAccount,
  getStreams,
  getStreamsByCategory,
  getCategoriesWithStreams,
  updateTables,
  updateCategoriesVisibility,
  addFavourite,
  removeFavourite,
  getFavourites,
  getFavouriteChannels,
};
