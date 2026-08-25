# amap-navigation

Use this skill for AMap navigation sessions.

## Task Shape

- `高德地图导航到北京站5分钟`
- `运行10分钟高德地图导航到上海虹桥站`

## Behavior

The skill:

- requires a destination
- opens AMap through `androidamap://route`
- waits for route calculation
- taps the lower primary action area to start navigation
- keeps the navigation session active for the requested duration

Successful execution means the foreground package is `com.autonavi.minimap` and the UI enters a route/navigation state, such as showing an exit-navigation control, ETA, or distance.

## Limits

If the destination is ambiguous, AMap may show candidate results instead of starting navigation. Use a more specific destination in the task text.
