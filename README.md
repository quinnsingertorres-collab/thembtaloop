# In the Loop

In the Loop is a real-time tracker for the MBTA subway lines, including the Mattapan High Speed Line — built as a single-page web app with live vehicle positions, community-driven reporting for Green Line operations. In the Loop is still in heavy development.

**Live site:** [thembtaloop.com](https://thembtaloop.com)

**Discord:** [discord.gg/RYckv4jz8n](https://discord.gg/RYckv4jz8n)

Not affiliated with the MBTA.

## Features

- **Live vehicle tracking** across all four lines and Mattapan, with GPS-based positioning between stops
- **Branch-aware routing** for the Green Line (B/C/D/E) and Red Line (Ashmont/Braintree), including cross-branch visibility toggles at shared stations
- **Fleet roster** with car type, builder, and rebuild status for the Green Line fleet
- **Community reporting**, including:
  - Consist corrections (when MBTA's feed doesn't match the real car numbers)
  - Destination overrides for short-turns and extensions
  - Trains running express or standing by at a station
  - Car out-of-service status
  - Trip notes
  - GLTPS (Green Line Type 7 Priority Seating) status per car
- **Real-time arrival predictions** with bunching detection
- **Push notifications** for moderator-posted alerts, even when the site is closed
- **Progressive Web App** support — installable to your home screen
- **Moderator and Trusted Member roles** for managing community reports, operator info, and service alerts
- **Points and leaderboard system** to recognize active contributors

## Tech stack

- Single-file HTML/CSS/JS front end, deployed on [Vercel](https://vercel.com)
- [Firebase](https://firebase.google.com) (Firestore, Authentication, Cloud Functions) for community data and push notifications
- [MBTA V3 API](https://www.mbta.com/developers/v3-api) for live vehicle and prediction data
- [Open-Meteo](https://open-meteo.com) for weather data

## Companion project

A [Discord bot](https://github.com/quinnsingertorres-collab/in-the-loop-bot) mirrors live alerts and adds train-spotting features for the Green Line community on Discord.

---

Built and maintained by Quinn Willow.
