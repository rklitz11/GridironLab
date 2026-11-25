# Refreshing the phone page (for scheduled cloud runs)

The page lives at https://claude.ai/artifact/MVbzrefY82DeRrCF6uoWkn. It is a small page (`week.html`) plus one file per week (`weeks/w1.html` … `weeks/w18.html`) that it loads on demand.

1. Run `npm run update` with a 10-minute timeout. It downloads the latest nflverse data, fetches weather, builds features and trains the models (about 5–8 minutes). If it fails, read the error and retry once; if it fails again, stop and report the error.
2. Run `npm run mobile`. It writes `data/out/mobile/week.html` and `data/out/mobile/weeks/wN.html`.
3. Publish to the existing page with the Artifact tool. Never create a new artifact, never use `force`, and never edit the generated files by hand.
   1. `action: "read"` with `url` set to the page link.
   2. `action: "list"` with `scope: "files"` and the same `url`, so the published week files count as seen.
   3. `action: "publish"` with `url` set to the page link, `file_path` set to `data/out/mobile/week.html`, and `files` mapping every file in `data/out/mobile/weeks/` to `weeks/<same name>`, for example `{"weeks/w1.html": "data/out/mobile/weeks/w1.html", …}`.
   4. If the publish is refused because the live page was not viewed, Read the saved copy it names in full (it is small), then repeat step 3.3 unchanged. If it is refused once more as identical content, repeat it unchanged one more time.
   5. If a `weeks/` path is refused as unread or changed, repeat step 3.2 and then step 3.3.
4. If `data/cache/weather.json` changed or there are new files in `data/cache/props/`, commit only those with the message "Update weather and prop-line cache" and push to `main`. Commit nothing else. (`npm run update` pulls Hard Rock prop lines for games kicking off within 3 hours, once per game, and skips this when `ODDS_API_KEY` is not set. Mention in the report how many games' lines were saved and how many credits are left.)
5. Finish with a short report: the week the page opens on, whether the publish succeeded, and any errors.
