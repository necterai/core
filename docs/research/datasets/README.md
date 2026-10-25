# Behavioural datasets (research use)

Downloaded by the research agents on 2026-10-24 for threshold calibration of the behaviour module.

* `balabit/` — three sessions from the Balabit Mouse Dynamics Challenge dataset (real human mouse telemetry: timestamps, button state, x, y). Used to calibrate pointer-kinematics features (sampling rate, speed profiles, curvature, pause structure).
* `cmu/DSL-StrongPasswordData.csv` — CMU keystroke dynamics benchmark (hold and latency times for 51 typists). Used to calibrate inter-key timing variance thresholds.

The files are not committed: they belong to their authors (the Balabit repository has no licence; the CMU benchmark is offered for research). Run `pnpm datasets` to download them from the original sources:

* https://github.com/balabit/Mouse-Dynamics-Challenge
* https://www.cs.cmu.edu/~keystroke/

The browser tests that replay them are skipped when the files are missing.
