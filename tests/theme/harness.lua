-- Runs src/theme/offsethelper.lua against stand-ins for the Etterna functions it uses (actors,
-- File, FILEMAN, INPUTFILTER, SCREENMAN, GAMESTATE) and plays it through: Sync, the page's answer,
-- hovering the result, Apply, Undo, an uncertain answer and a page that does not answer.
-- Run: lua tests/theme/harness.lua (from the project folder).

local failures = 0
local function check(what, ok, detail)
	if ok then
		print("ok   " .. what)
	else
		failures = failures + 1
		print("FAIL " .. what .. (detail and (": " .. tostring(detail)) or ""))
	end
end

-- Etterna stand-ins ---------------------------------------------------------------------------

local now = 0
function GetTimeSinceStart() return now end
function capWideScale(_, wide) return wide end
function get43size(x) return x end
function color(hex) return hex end
function getMainColor(name) return "main:" .. name end

local files = {}
File = {
	Write = function(path, text) files[path] = text return true end,
	Read = function(path) return files[path] end
}
local flushed = 0
FILEMAN = {FlushDirCache = function(_, dir) flushed = flushed + 1 end}
local mouse = {x = -100, y = -100}
INPUTFILTER = {GetMouseX = function() return mouse.x end, GetMouseY = function() return mouse.y end}
local song = {
	GetSongDir = function() return "/AdditionalSongs/Solo Pack/Zoltraak/" end,
	GetSongFilePath = function() return "/AdditionalSongs/Solo Pack/Zoltraak/Zoltraak.sm" end,
	GetMusicPath = function() return "/AdditionalSongs/Solo Pack/Zoltraak/audio.mp3" end
}
local currentSong = song
GAMESTATE = {GetCurrentSong = function() return currentSong end}
local callback
local reloads = 0
local screen = {
	AddInputCallback = function(_, f) callback = f end,
	ReloadCurrentSong = function() reloads = reloads + 1 end
}
SCREENMAN = {GetTopScreen = function() return screen end}

-- Actor definitions are plain tables; LoadFont(...) .. {...} merges like Etterna's does.
local defMeta = {__concat = function(a, b) local t = {} for k, v in pairs(a) do t[k] = v end for k, v in pairs(b) do t[k] = v end return setmetatable(t, getmetatable(a)) end}
Def = {
	ActorFrame = function(t) t.Class = "ActorFrame" return setmetatable(t, defMeta) end,
	Sprite = function(t) t.Class = "Sprite" return setmetatable(t, defMeta) end
}
function LoadFont(name) return setmetatable({Class = "BitmapText", Font = name}, defMeta) end

-- Actors: position, alignment, zoom, text (8 px per character at zoom 1, 20 px high) and children.
local Actor = {}
Actor.__index = Actor
local function build(def, parent)
	local a = setmetatable({def = def, parent = parent, children = {}, px = 0, py = 0, ha = 0.5, va = 0.5, z = 1, text = "", shown = true, alpha = 1, w = 0, h = 0}, Actor)
	for _, child in ipairs(def) do
		local c = build(child, a)
		a.children[#a.children + 1] = c
	end
	return a
end
function Actor:playcommand(name) local f = self.def[name .. "Command"] if f then f(self) end for _, c in ipairs(self.children) do c:playcommand(name) end return self end
function Actor:queuecommand(name) return self:playcommand(name) end
function Actor:sleep() return self end
function Actor:xy(x, y) self.px, self.py = x, y return self end
function Actor:x(x) self.px = x return self end
function Actor:y(y) self.py = y return self end
function Actor:halign(v) self.ha = v return self end
function Actor:valign(v) self.va = v return self end
function Actor:GetHAlign() return self.ha end
function Actor:GetVAlign() return self.va end
function Actor:zoom(z) self.z = z return self end
function Actor:zoomto(w, h) self.w, self.h = w, h return self end
function Actor:settext(t) self.text = t return self end
function Actor:diffuse(c) self.color = c return self end
function Actor:diffusealpha(a) self.alpha = a return self end
function Actor:visible(v) self.shown = v return self end
function Actor:GetVisible() return self.shown end
function Actor:Load(path) self.texture = path return self end
function Actor:GetParent() return self.parent end
function Actor:GetChild(name) for _, c in ipairs(self.children) do if c.def.Name == name then return c end end return nil end
function Actor:GetZoomedWidth() return self.def.Class == "BitmapText" and #self.text * 8 * self.z or self.w end
function Actor:GetZoomedHeight() return self.def.Class == "BitmapText" and 20 * self.z or self.h end
function Actor:GetX() return self.px end
function Actor:GetY() return self.py end
function Actor:GetTrueX() return self.px + (self.parent and self.parent:GetTrueX() or 0) end
function Actor:GetTrueY() return self.py + (self.parent and self.parent:GetTrueY() or 0) end
function Actor:SetUpdateFunction(f) self.update = f return self end
function Actor:SetUpdateFunctionInterval(s) self.interval = s return self end

-- Load the widget ------------------------------------------------------------------------------

local root = build(dofile("src/theme/offsethelper.lua"))
local function init(a) local f = a.def.InitCommand if f then f(a) end for _, c in ipairs(a.children) do init(c) end end
init(root)
root:playcommand("On")
local line = root.children[3]
local map = root:GetChild("OffsetHelperMap")
local function text(name) return line:GetChild(name).text end
local function tick(times) for _ = 1, times or 1 do now = now + 0.05 line.update(line) end end
local function point(name) local a = line:GetChild(name) mouse.x = a:GetTrueX() + 1 mouse.y = a:GetTrueY() end
local function click(name)
	point(name)
	return callback({type = "InputEventType_FirstPress", DeviceInput = {button = "DeviceButton_left mouse button"}})
end
local function request() local r = {} for k, v in string.gmatch(files["/OffsetHelper/request.txt"] or "", "([%w_]+)=([^\n]*)") do r[k] = v end return r end
local function answer(t) files["/OffsetHelper/result.txt"] = t end

-- Play it through ------------------------------------------------------------------------------

check("starts with the Sync button", text("Label") == "Offset:" and text("Sync") == "Sync" and text("Info") == "", text("Info"))
check("Sync sits after the label", line:GetChild("Sync").px > line:GetChild("Label").px)
-- Til' Death's other tabs cover the line's place: it hides there and takes no clicks.
local tab = 0
function getTabIndex() return tab end
tab = 2
root:playcommand("TabChangedMessage")
check("hidden on Til' Death's other tabs", line.shown == false)
check("no clicks while hidden", click("Sync") == false and files["/OffsetHelper/request.txt"] == nil)
tab = 0
root:playcommand("TabChangedMessage")
check("back on the General tab", line.shown == true)
check("clicking elsewhere does nothing", (function() mouse.x, mouse.y = 500, 400 return callback({type = "InputEventType_FirstPress", DeviceInput = {button = "DeviceButton_left mouse button"}}) end)() == false)

check("clicking Sync asks the page", click("Sync") == true and request().action == "measure" and request().dir == "/AdditionalSongs/Solo Pack/Zoltraak/")
local id = request().id
check("shows that it is measuring", text("Info") == "measuring...", text("Info"))
answer("id=" .. id .. "\nstatus=busy\n")
now = now + 30
tick(10)
check("waits for a page that said busy", text("Info") == "measuring...", text("Info"))
answer("id=" .. id .. "\nstatus=ready\ncurrent=-0.453000\nsure=1\ninsync=0\nchoice1=-0.438235 +14.8\nmap=/OffsetHelper/map-" .. id .. ".png\n")
tick(10)
check("shows the result", text("Info") == "+14.8 ms -> -0.438235", text("Info"))
check("offers Apply", text("B1") == "Apply")
check("loads the sync map", map.texture == "/OffsetHelper/map-" .. id .. ".png" and map.w == 384 and map.h == 120 and flushed > 0, map.texture)
check("map hidden until the result is hovered", map.shown == false)
point("Info")
tick()
check("map shows while the result is hovered", map.shown == true)
mouse.x = -100
tick()
check("map hides again", map.shown == false)

check("clicking Apply asks for choice 1", click("B1") == true and request().action == "apply" and request().choice == "1")
id = request().id
answer("id=" .. id .. "\nstatus=applied\noffset=-0.438235\nmap=/OffsetHelper/map-" .. id .. ".png\n")
tick(10)
check("applied: song reloaded", reloads == 1)
check("applied: says so and offers Undo", text("Info") == "applied -0.438235" and text("B1") == "Undo", text("Info"))
check("applied: shows the centred map", map.texture == "/OffsetHelper/map-" .. id .. ".png")

check("clicking Undo asks the page", click("B1") == true and request().action == "undo")
id = request().id
answer("id=" .. id .. "\nstatus=restored\nmap=/OffsetHelper/map-" .. id .. ".png\n")
tick(10)
check("undone: song reloaded", reloads == 2)
check("undone: says so", text("Info") == "restored -0.453000" and text("B1") == "", text("Info"))

click("Sync")
id = request().id
answer("id=" .. id .. "\nstatus=ready\ncurrent=-0.274286\nsure=0\ninsync=0\nchoice1=-0.282555 -8.3\nchoice2=-0.358719 -84.4\nmap=/OffsetHelper/map-" .. id .. ".png\n")
tick(10)
check("unsure: offers each choice", text("Info") == "not sure, beat at:" and text("B1") == "1: -8.3 ms" and text("B2") == "2: -84.4 ms" and text("B3") == "", text("Info"))
check("unsure: the second choice applies choice 2", click("B2") == true and request().action == "apply" and request().choice == "2")
check("no second request while one is waiting", click("Sync") == false and request().action == "apply")
id = request().id
answer("id=" .. id .. "\nstatus=applied\noffset=-0.358719\n")
tick(10)
check("unsure: applied choice 2", text("Info") == "applied -0.358719" and reloads == 3, text("Info"))

click("Sync")
tick(10)
check("no answer yet", text("Info") == "measuring...")
now = now + 7
tick(10)
check("no answer: tells to open the page", string.find(text("Info"), "No answer", 1, true) == 1, text("Info"))
check("no answer: a failure, in red", line:GetChild("Info").color == "#e06c6c", line:GetChild("Info").color)

answer("id=old\nstatus=ready\nchoice1=1 +1\n")
click("Sync")
tick(10)
check("ignores an answer to another request", text("Info") == "measuring...", text("Info"))

currentSong = nil
root:playcommand("CurrentSongChangedMessage")
check("hidden on a pack (no song)", line.shown == false)
currentSong = song
root:playcommand("CurrentSongChangedMessage")
check("back on a song", line.shown == true)

local probe = files["/OffsetHelper/probe.txt"] or ""
check("probe: reports the Lua it runs on", string.find(probe, "lua=Lua 5", 1, true) ~= nil and string.find(probe, "jit=none", 1, true) ~= nil, probe)
check("probe: reports whether the FFI loads", string.find(probe, "ffi=no", 1, true) ~= nil and string.find(probe, "loop_2M_ms=", 1, true) ~= nil, probe)
local writes = 0
local write = File.Write
File.Write = function(path, text) if path == "/OffsetHelper/probe.txt" then writes = writes + 1 end return write(path, text) end
root:playcommand("On")
check("probe: only once per start", writes == 0)

-- With the DLL ---------------------------------------------------------------------------------
-- A fake FFI and DLL: the measuring itself is tested in C (native/), here only what Lua does with it.

local SM = "/AdditionalSongs/Solo Pack/Zoltraak/Zoltraak.sm"
local ORIGINAL = "#TITLE:Zoltraak;\r\n// #OFFSET:1;\r\n#OFFSET:-0.453;\r\n#BPMS:0=145;\r\n"
files[SM] = ORIGINAL
files["/AdditionalSongs/Solo Pack/Zoltraak/audio.mp3"] = "MUSIC"
FILEMAN.GetDirListing = function(_, pattern) return string.find(pattern, "%.sm$") and {SM} or {} end
local TRUE_OFFSET = -0.438235
local measured, decodedPaths, mapFiles, freed, loads = {}, {}, {}, {}, 0
files["/Save/Preferences.ini"] = "[Options]\r\nAdditionalSongFolders=E:\\Games\\Etterna\\Songs_solo, D:\\Games\\common song folder\\\r\nGlobalOffsetSeconds=0\r\n"
local fakeLib = {
	oh_decode_file = function(path) decodedPaths[#decodedPaths + 1] = path return path == "D:\\Games\\common song folder\\Solo Pack\\Zoltraak\\audio.mp3" and {id = #decodedPaths} or {id = #decodedPaths, error = "cannot open the music file"} end,
	oh_error = function(song) return song.error end,
	oh_duration = function() return 10 end,
	oh_measure = function(song, beats, count, offset) measured[#measured + 1] = {count = count, first = beats.t[1], offset = offset} song.shift = (offset - TRUE_OFFSET) * 1000 return 0 end,
	oh_choice_count = function() return 1 end,
	oh_choice_offset = function() return TRUE_OFFSET end,
	oh_choice_shift = function(song) return song.shift end,
	oh_map_bmp_file = function(_, w, h, path) mapFiles[#mapFiles + 1] = path return 0 end,
	oh_map_range = function() return 60 end,
	oh_free = function(song) freed[#freed + 1] = song.id end
}
local loadedFrom
local fakeFfi = {
	cdef = function() end,
	C = {
		GetModuleFileNameA = function(_, buffer) buffer.s = "E:\\Games\\Etterna\\Program\\Etterna.exe" end,
		GetCurrentDirectoryA = function(_, buffer) buffer.s = "E:\\Games\\Etterna\\Program" end
	},
	new = function(kind, n, t) return {t = t} end,
	string = function(p, n) return type(p) == "table" and p.s or p end,
	load = function(path) loads = loads + 1 if path == "E:\\Games\\Etterna\\Program\\..\\OffsetHelper\\offsethelper.dat" then loadedFrom = path return fakeLib end error("not found: " .. path) end,
	gc = function(x) return x end
}
package.preload.ffi = function() return fakeFfi end
jit = {os = "Windows", arch = "x64", version = "LuaJIT 2.1", status = function() return true end}
GAMESTATE.GetCurrentSteps = function()
	return {GetTimingData = function()
		-- As Etterna's: NoOffset is the chart's timeline (beat 0 at -#OFFSET); the other one also
		-- subtracts the player's global offset (here -0.015470) times the rate.
		return {
			GetElapsedTimeFromBeat = function(_, b) return b * 60 / 145 + 0.453 + 0.015470 end,
			GetElapsedTimeFromBeatNoOffset = function(_, b) return b * 60 / 145 + 0.453 end
		}
	end}
end
reloads = 0
OFFSETHELPER_PROBED = true
root = build(dofile("src/theme/offsethelper.lua"))
init(root)
root:playcommand("On")
line = root.children[3]
map = root:GetChild("OffsetHelperMap")

files["/OffsetHelper/request.txt"] = nil
click("Sync")
check("dll: loaded from Etterna's folder", loadedFrom ~= nil, loadedFrom)
check("dll: no request to the page", files["/OffsetHelper/request.txt"] == nil)
check("dll: measured with the chart's offset and beats to the end", measured[1] and math.abs(measured[1].offset + 0.453) < 1e-9 and measured[1].count == 24 and math.abs(measured[1].first - 0.453) < 1e-9, measured[1] and (measured[1].offset .. " " .. measured[1].count))
check("dll: shows the result", text("Info") == "+14.8 ms -> -0.438235" and text("B1") == "Apply", text("Info"))
check("dll: opens the music in the extra song folders, in order", decodedPaths[1] == "E:\\Games\\Etterna\\Songs_solo\\Solo Pack\\Zoltraak\\audio.mp3" and decodedPaths[2] == "D:\\Games\\common song folder\\Solo Pack\\Zoltraak\\audio.mp3", table.concat(decodedPaths, " | "))
check("dll: has the map written in Etterna's folder", map.texture == "/OffsetHelper/map-native-1.bmp" and mapFiles[1] == "E:\\Games\\Etterna\\Program\\..\\OffsetHelper\\map-native-1.bmp", mapFiles[1])
point("Info")
tick()
local labels = root:GetChild("OffsetHelperLabels")
check("dll: map and its labels show on hover", map.shown and labels.shown and labels:GetChild("L1").text == "-30" and labels:GetChild("L4").text == "+30" and labels:GetChild("L5").shown == false)
click("B1")
check("dll: Apply changes only the offset digits", files[SM] == string.gsub(ORIGINAL, "#OFFSET:%-0%.453;", "#OFFSET:-0.438235;"), files[SM])
check("dll: Apply reloads the song", reloads == 1)
check("dll: says so and offers Undo", text("Info") == "applied -0.438235" and text("B1") == "Undo", text("Info"))
check("dll: the map again with the new offset", measured[2] and math.abs(measured[2].offset - TRUE_OFFSET) < 1e-9 and math.abs(measured[2].first - (0.453 + (-0.453 - TRUE_OFFSET))) < 1e-9 and map.texture == "/OffsetHelper/map-native-2.bmp")
click("B1")
check("dll: Undo puts the file back", files[SM] == ORIGINAL)
check("dll: Undo reloads and says so", reloads == 2 and text("Info") == "restored -0.453000" and text("B1") == "", text("Info"))
-- An Apply is remembered: after another song, and after Etterna restarts, the line still says
-- so and Undo puts the file's own offset back.
click("Sync")
click("B1")
check("remembered: written to synced.txt", files["/OffsetHelper/synced.txt"] == "/AdditionalSongs/Solo Pack/Zoltraak/\t-0.438235\t-0.453\n", files["/OffsetHelper/synced.txt"])
local other = {GetSongDir = function() return "/Songs/Other/Song/" end, GetSongFilePath = song.GetSongFilePath, GetMusicPath = song.GetMusicPath}
currentSong = other
root:playcommand("CurrentSongChangedMessage")
currentSong = song
root:playcommand("CurrentSongChangedMessage")
check("remembered: shown again with Undo after another song", text("Info") == "applied -0.438235" and text("B1") == "Undo", text("Info"))
local function restart()
	OFFSETHELPER_SESSION.synced = nil
	root = build(dofile("src/theme/offsethelper.lua"))
	init(root)
	root:playcommand("On")
	line = root.children[3]
	map = root:GetChild("OffsetHelperMap")
end
restart()
check("remembered: shown after a restart", text("Info") == "applied -0.438235" and text("B1") == "Undo", text("Info"))
point("Info")
tick()
check("remembered: no map without a measurement", map.shown == false)
mouse.x = -100
reloads = 0
click("B1")
check("remembered: Undo puts the file back as it was", files[SM] == ORIGINAL, files[SM])
check("remembered: Undo reloads, says so and forgets it", reloads == 1 and text("Info") == "restored -0.453" and files["/OffsetHelper/synced.txt"] == "", text("Info"))
click("Sync")
click("B1")
files[SM] = string.gsub(ORIGINAL, "%-0%.453", "-0.4")
click("B1")
check("undo: an offset changed since is left alone", files[SM] == string.gsub(ORIGINAL, "%-0%.453", "-0.4") and string.find(text("Info"), "changed", 1, true) ~= nil and files["/OffsetHelper/synced.txt"] == "", text("Info"))
check("undo: amber, not red", line:GetChild("Info").color == "#d9a64a", line:GetChild("Info").color)
files[SM] = ORIGINAL
click("Sync")
click("B1")
files[SM] = string.gsub(ORIGINAL, "%-0%.453", "-0.4")
restart()
click("B1")
check("remembered: an offset changed since is left alone", files[SM] == string.gsub(ORIGINAL, "%-0%.453", "-0.4") and string.find(text("Info"), "changed", 1, true) ~= nil and files["/OffsetHelper/synced.txt"] == "", text("Info"))
check("remembered: amber, not red", line:GetChild("Info").color == "#d9a64a", line:GetChild("Info").color)
files[SM] = ORIGINAL
click("Sync")
click("B1")
click("Sync")
check("remembered: synced again, Undo next to Apply", text("B1") == "Apply" and text("B2") == "Undo", text("B2"))
click("B2")
check("remembered: that Undo puts the first offset back", files[SM] == ORIGINAL, files[SM])

click("Sync")
files[SM] = string.gsub(ORIGINAL, "%-0%.453", "-0.5")
click("B1")
check("dll: a file changed meanwhile is left alone", files[SM] == string.gsub(ORIGINAL, "%-0%.453", "-0.5") and string.find(text("Info"), "changed", 1, true) ~= nil, text("Info"))
check("dll: that is a warning (amber), not a failure (red)", line:GetChild("Info").color == "#d9a64a", line:GetChild("Info").color)

-- Leaving song select for gameplay and coming back: the DLL stays loaded and each decoded song is
-- freed exactly once, when another is measured or selected (freeing it after the DLL was unloaded
-- crashed Etterna).
local function count(list, v) local n = 0 for _, x in ipairs(list) do if x == v then n = n + 1 end end return n end
check("session: a song that could not be opened is freed at once", count(freed, 1) == 1, table.concat(freed, ","))
local kept = decodedPaths[#decodedPaths] and #decodedPaths
root = build(dofile("src/theme/offsethelper.lua"))
init(root)
root:playcommand("On")
line = root.children[3]
map = root:GetChild("OffsetHelperMap")
root:playcommand("CurrentSongChangedMessage")
check("session: back on song select the measured song is still there", count(freed, kept) == 0, table.concat(freed, ","))
click("Sync")
check("session: the DLL was loaded once", loads == 1, loads)
check("session: measuring again frees the previous song once", count(freed, kept) == 1, table.concat(freed, ","))
local current = #decodedPaths
currentSong = {GetSongDir = function() return "/Songs/Other/Song/" end, GetSongFilePath = song.GetSongFilePath, GetMusicPath = song.GetMusicPath}
root:playcommand("CurrentSongChangedMessage")
check("session: selecting another song frees it", count(freed, current) == 1, table.concat(freed, ","))
local doubles = false
for _, v in ipairs(freed) do if count(freed, v) > 1 then doubles = true end end
check("session: nothing freed twice", not doubles, table.concat(freed, ","))

-- Rebirth: a screen 720 high, the line right-aligned in the header, the map over the banner of
-- its song box wherever the box is (here moved to the left, as with the wheel on the right).
THEME = {GetCurThemeName = function() return "Rebirth" end}
SCREEN_WIDTH, SCREEN_HEIGHT = 1280, 720
local rightFrame = build(Def.ActorFrame {Name = "RightFrame", Def.ActorFrame {Name = "CurSongBoxFile", Def.ActorFrame {Name = "Frame"}}})
rightFrame:x(-760)
rightFrame:GetChild("CurSongBoxFile"):GetChild("Frame"):xy(760, 72)
screen.GetChild = function(_, name) return name == "RightFrame" and rightFrame or nil end
currentSong = song
root = build(dofile("src/theme/offsethelper.lua"))
init(root)
root:playcommand("On")
line = root.children[3]
map = root:GetChild("OffsetHelperMap")
click("Sync")
check("rebirth: measures", text("Info") == "+14.8 ms -> -0.438235" and text("B1") == "Apply", text("Info"))
local last = line:GetChild("B1")
local rightEnd = last:GetTrueX() + last:GetZoomedWidth()
check("rebirth: the line ends where the header's icons end", math.abs(rightEnd - (1280 - 1280 * 38 / 1920)) < 1e-6 and math.abs(line:GetTrueY() - 60) < 1e-6, rightEnd .. " " .. line:GetTrueY())
check("rebirth: text sized for 720", line:GetChild("Sync").z == 0.55)
point("Info")
tick()
labels = root:GetChild("OffsetHelperLabels")
check("rebirth: the map covers the song box's banner", map.shown and map.px == 0 and map.py == 72 and math.abs(map.w - 520) < 1e-6 and math.abs(map.h - 162) < 1e-6 and labels.px == 0 and labels.py == 72, map.px .. "," .. map.py .. " " .. map.w .. "x" .. map.h)
THEME, SCREEN_WIDTH, SCREEN_HEIGHT = nil, nil, nil

-- As an overlay screen (ScreenOffsetHelper, installed in _fallback for every theme): the overlay
-- screen takes the input, the line shows only while song select is on top, and in a theme whose
-- layout is not known it sits bottom left, can be dragged and put back.
THEME = {GetCurThemeName = function() return "Some Theme" end}
local overlayScreen = {AddInputCallback = function(_, f) callback = f end}
function overlayScreen:GetTrueX() return 0 end
function overlayScreen:GetTrueY() return 0 end
function overlayScreen:GetParent() return nil end
local songSelect = {GetMusicWheel = function() end, ReloadCurrentSong = screen.ReloadCurrentSong, AddInputCallback = function() error("the overlay takes input from its own screen") end}
local top = songSelect
SCREENMAN = {GetTopScreen = function() return top end}
local function loadOverlay()
	callback = nil
	root = build(loadfile("src/theme/offsethelper.lua")("overlay"))
	root.parent = overlayScreen
	init(root)
	root:playcommand("On")
	line = root:GetChild("OffsetHelperLine")
	map = root:GetChild("OffsetHelperMap")
end
local function press(button, kind) return callback({type = kind or "InputEventType_FirstPress", DeviceInput = {button = "DeviceButton_" .. button .. " mouse button"}}) end
local POS = "/OffsetHelper/position.txt"
loadOverlay()
check("overlay: takes input from its own screen", callback ~= nil)
check("overlay: other themes get the line bottom left", line.px == 10 and line.py == 430 and line.shown == true, line.px .. "," .. line.py)
top = {}
tick()
check("overlay: hidden over other screens", line.shown == false)
check("overlay: no clicks there", click("Sync") == false)
top = songSelect
tick()
check("overlay: back on song select", line.shown == true)
click("Sync")
check("overlay: measures", text("Info") == "+14.8 ms -> -0.438235", text("Info"))
point("Info")
tick()
check("overlay: the map above the line in the screen's lower half", map.shown == true and map.px == 10 and math.abs(map.py - (430 - 12 - 120)) < 1e-6, map.px .. "," .. map.py)
mouse.x = -100
tick()
point("Label")
local grabX, grabY = mouse.x, mouse.y
check("overlay: the Offset word takes hold", press("left") == true)
mouse.x, mouse.y = grabX + 200, grabY - 300
tick()
check("overlay: the line follows the mouse", line.px == 210 and line.py == 130, line.px .. "," .. line.py)
check("overlay: letting go keeps the place for this theme", press("left", "InputEventType_Release") == true and files[POS] == "Some Theme\t0.2459\t0.2708\n", files[POS])
point("Info")
tick()
check("overlay: the map below the line in the upper half", map.shown == true and math.abs(map.py - 142) < 1e-6, map.py)
mouse.x = -100
tick()
loadOverlay()
check("overlay: the place kept after a restart", math.abs(line.px - 210) < 0.1 and math.abs(line.py - 130) < 0.1, line.px .. "," .. line.py)
point("Label")
check("overlay: right-click puts it back", press("right") == true and line.px == 10 and line.py == 430 and files[POS] == "", line.px .. "," .. line.py .. " " .. tostring(files[POS]))
local copy = build(dofile("src/theme/offsethelper.lua"))
check("overlay: a copy loaded from a theme stays empty", #copy.children == 0, #copy.children)
THEME = {GetCurThemeName = function() return "Til Death" end}
loadOverlay()
check("overlay: Til' Death keeps its place above the banner", line.px == 10 and line.py == 50, line.px .. "," .. line.py)
THEME, OFFSETHELPER_OVERLAY = nil, nil

print(failures == 0 and "all passed" or (failures .. " failed"))
os.exit(failures == 0 and 0 or 1)
