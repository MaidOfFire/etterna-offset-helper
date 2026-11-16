-- Etterna offset helper: https://maidoffire.github.io/etterna-offset-helper/
-- The ScreenOffsetHelper overlay screen (listed in OverlayScreens in Themes/_fallback/metrics.ini),
-- drawn over every screen in every theme. offsethelper.lua beside it shows its line on song select.
-- Not "return LoadActor(...)": as a tail call it leaves no trace of this file, and LoadActor finds
-- "offsethelper" next to the file that called it.
local t = LoadActor("offsethelper", "overlay")
return t
