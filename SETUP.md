# Listing Watch — setup (GitHub version)

The app checks your RE/MAX listings every morning at **7:30 AM Cabo time** and sends a phone notification when a price changes or a listing disappears. Everything runs free on GitHub; alerts come through the free **ntfy** app.

```
index.html, manifest.json, icons     the iPhone app (GitHub Pages)
data/listings.json                    YOUR list: RE/MAX ID + your name for each
data/state.json                       prices, status, history (updated by the daily check)
scripts/check.mjs                     the checker
.github/workflows/check-listings.yml  runs the checker daily at 7:30 AM
```

About 15 minutes.

---

## 1. Create the repo

1. On GitHub: **New repository** › name it `listing-watch` › **Public** › Create.
   > GitHub Pages is free only for public repos, so anyone with the address could see your 4 listing names and prices. If you'd rather keep it private, that needs GitHub Pro (~$4/month).
2. **Add file › Upload files** › drag in **everything inside** the `listing-watch-gh` folder, keeping the folders (`.github`, `data`, `scripts`) › **Commit changes**.
   > The `.github` folder is hidden on Mac/Windows by default. If it doesn't upload, create the file by hand: **Add file › Create new file**, name it `.github/workflows/check-listings.yml`, paste the file's contents, commit.

## 2. Notifications (ntfy)

1. Install **ntfy** from the App Store (free).
2. In ntfy tap **+** › Topic name: `listingwatch-p5k9qxrnes1cic` › Subscribe. Allow notifications.
   > Anyone who knows this topic name could read or send alerts, so keep it private. You can use your own random name instead, as long as it matches step 3.
3. In the repo: **Settings › Secrets and variables › Actions › New repository secret**
   - Name: `NTFY_TOPIC`
   - Secret: `listingwatch-p5k9qxrnes1cic`

## 3. Let the check save results

**Settings › Actions › General › Workflow permissions** › select **Read and write permissions** › Save.

## 4. Turn on the app address

**Settings › Pages** › Source: **Deploy from a branch** › Branch: **main**, folder **/ (root)** › Save.
After a minute your app is at `https://<your-github-username>.github.io/listing-watch/`.

## 5. Test it (important)

Go to **Actions › Check listings › Run workflow**:

1. Tick **Send a test notification** › Run. Your phone should show "Notifications are working ✓" from ntfy.
2. Tick **Dry run** › Run. Open the run › **Check RE/MAX listings** step. Each listing should show `"state": "active"` with a `price`.
   - **If you see** `RE/MAX returned HTTP 403` or every listing says `gone`, RE/MAX is blocking GitHub's servers. Send me that log and I'll switch to the iPhone Shortcuts fallback.
3. Run once more with nothing ticked. This saves the starting prices (no alerts the first time).

## 6. Install on your iPhone

Open the app address in **Safari** › **Share ⬆︎ › Add to Home Screen** › Add. It shows up as **Listings**.

---

## Using it

- **Every morning at 7:30 AM** GitHub checks each listing (GitHub can start scheduled runs a few minutes late).
- **You get an ntfy alert only when something changes:** price drop, price up, sold or removed?, or back on the market. Several changes on the same day come as one alert. Tapping an alert opens the app on that listing.
- Before calling a listing gone, it waits a few seconds and checks again.
- If RE/MAX can't be reached 3 days in a row, you get a "can't reach RE/MAX" alert.
- **Check now:** the button opens GitHub's Run workflow page (you need to be signed in to GitHub). The app shows the new results a minute or two after the run finishes.
- **Add, rename or remove a listing:** the **Add / rename** button opens `data/listings.json` in GitHub's editor. Each line is `{ "id": "RE/MAX number", "name": "your name" }`. Keep the commas between lines. Commit, and the next check picks it up.
- **Change the time:** edit `cron: "30 14 * * *"` in `.github/workflows/check-listings.yml` (minute, hour in UTC; Cabo = UTC − 7).
