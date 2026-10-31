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
function Actor:xy(x, y) self.px, self.py = x, y return self end
function Actor:x(x) self.px = x return self end
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
function Actor:GetTrueX() return self.px + (self.parent and self.parent:GetTrueX() or 0) end
function Actor:GetTrueY() return self.py + (self.parent and self.parent:GetTrueY() or 0) end
function Actor:SetUpdateFunction(f) self.update = f return self end
function Actor:SetUpdateFunctionInterval(s) self.interval = s return self end

-- Load the widget ------------------------------------------------------------------------------

local root = build(dofile("src/theme/offsethelper.lua"))
local function init(a) local f = a.def.InitCommand if f then f(a) end for _, c in ipairs(a.children) do init(c) end end
init(root)
root:playcommand("On")
local line = root.children[2]
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

print(failures == 0 and "all passed" or (failures .. " failed"))
os.exit(failures == 0 and 0 or 1)
