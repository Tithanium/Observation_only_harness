# map_folder_full.md — the FULL structure of C:\Users\connessn\Observation_only\test_trees\sample as one mermaid graph

Human AND machine readable: ONE node per folder and per file of the working
folder (label = the path relative to the working folder, "." = the working
folder, folders carry a "/" suffix), ONE edge per parent → child link.
It contains ALL folders and files — everything, not only the working folder —
and can be LARGE: do not read it whole, have a SUBAGENT read it and hand back
the paths of interest.

6 folder(s) mapped · 7 file(s) mapped

```mermaid
graph TD
  n0["."]
  n1[".hidden.txt"]
  n0 --> n1
  n2["empty/"]
  n0 --> n2
  n3["notes.md"]
  n0 --> n3
  n4["notes/"]
  n0 --> n4
  n5["pixel.bmp"]
  n0 --> n5
  n6["readme.md"]
  n0 --> n6
  n7["src/"]
  n0 --> n7
  n8["notes/deep/"]
  n4 --> n8
  n9["src/app.js"]
  n7 --> n9
  n10["src/utils/"]
  n7 --> n10
  n11["notes/deep/deep.txt"]
  n8 --> n11
  n12["src/utils/helper.js"]
  n10 --> n12
```
