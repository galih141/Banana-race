# Banana Racer

A small browser racing game (three.js). Cars and tracks are plain `.glb` files — drop a file in the right folder and the game finds it.

## Publish on GitHub Pages
1. Create a new repository on GitHub and upload everything in this folder (keep the folder structure; `.github` and `.nojekyll` are hidden files, make sure they are included).
2. **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save.**
3. After a minute the game is live at `https://YOUR-NAME.github.io/YOUR-REPO/`.

## Add a car or a track
Upload the `.glb` into **`assets/cars/`** or **`assets/tracks/`** (GitHub → *Add file → Upload files*).
A GitHub Action refreshes `assets/manifest.json` automatically, and the game lists the new file after the site rebuilds (about a minute).
Static or animated models both work (animations are played).

## Naming rules inside the `.glb`
**Car** (object / node names)
| Part | Name |
|---|---|
| Wheels | `front_left`, `front_right`, `back_left`, `back_right` |
| Body | any name **ending** in `cars_body` (`dog_cars_body`, `cat_cars_body`…) — `car_body` also works |

The game works out the rest by itself: which way the car faces (from front vs back wheels), wheel size, size on the track, how high it sits. Keep the wheels' origin at the wheel centre.

**Track**
| Part | Name |
|---|---|
| Road | any object whose name **starts** with `track` (`track_machine`, `track_fight`…). Only put the drivable surface under it. If that object also contains props, give the road material a name starting with `track` and only that material is used for driving. |
| Finish line | a box named `lap`, laid across the road (long side across the road, thin side along the road). It is hidden in the game. It can be a Cube mesh or a Blender cube empty. |

* Default race direction is clockwise seen from above. Name the box `lap_reverse` to go the other way.
* If a track has no `lap` box, the start is placed automatically.
* The road must be one closed loop (no crossings). Bots and lap counting follow the middle of the road, found automatically from the road mesh. Tracks are rescaled automatically so every road feels the same width.

## Controls
`↑/W` gas · `↓/S` brake · `←→/AD` steer · `Space` jump · `Shift` boost · **Drift:** hold `←` then also tap `→` (or the other way round) · `R` back on the road · `Enter` restart · `C` car/track menu · `M` mute.
Touch buttons appear on phones. In the menu: `←/→` car, `↑/↓` track, `Enter` start.

## Testing locally
Browsers block loading files from a folder when you double-click `index.html`. Either run a tiny server in this folder (`python -m http.server` then open `http://localhost:8000`) or open `index.html` and **drop your `.glb` files onto the page** (they are only kept until you reload).
To rebuild the file list by hand: `node tools/make-manifest.js`.
