# realm.pixels — world viewer and catalog

The public website of the @realm.pixels sim village on Instagram (1 follower = 1 villager, the most-liked comment
gets built, a city at 1,000 followers).

- `index.html`: fly around the world as it stands at the end of each day's reel, and play: the **Build** panel has a
  pickaxe, an axe (fells a whole tree, house, the castle...), blocks and stamps (castles, houses, trees, a bridge).
  Edits stay in your browser. The day picker also has two scenes: the hoard hall under the structure and the fixes.
- `catalog.html`: every villager, build, place, open thread, wish and day script.

This repo is generated from the private production repo (`viewer/public_build.py` there): only posted days are
shown (or everything, with `--all`). Do not edit files here by hand; rebuild and push instead.
