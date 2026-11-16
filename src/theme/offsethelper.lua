-- Etterna offset helper, in-game part: https://maidoffire.github.io/etterna-offset-helper/
--
-- A line on song select. Sync measures the selected song's offset, Apply writes the recommended
-- one and reloads the song. Hovering the result shows the sync map (over the banner in Til' Death
-- and Rebirth, next to the line in other themes). Dragging the "Offset:" word moves the line (kept
-- per theme in OffsetHelper/position.txt); right-clicking it puts it back.
--
-- The measuring is done by OffsetHelper/offsethelper.dat (or .dll), loaded through LuaJIT's FFI:
-- it decodes the music as Etterna plays it and measures it as the helper page does. Without the
-- DLL, the helper page does it (open in Chrome or Edge): this file and the page then talk through
-- OffsetHelper/request.txt and OffsetHelper/result.txt in the Etterna folder.
--
-- Installed by the helper page (it also removes it again) as an overlay screen, ScreenOffsetHelper,
-- in Themes/_fallback: Etterna draws overlay screens over every screen, in every theme, and the
-- line shows only while song select is the screen on top. Its loader passes "overlay". Older
-- installs loaded this file from Til' Death's or Rebirth's song select instead (no argument).

local MODE = ...
local OVERLAY = MODE == "overlay"
if OVERLAY then
	OFFSETHELPER_OVERLAY = true
elseif OFFSETHELPER_OVERLAY then
	-- The overlay already shows the line: a copy still loaded from a theme stays out of the way.
	return Def.ActorFrame {}
end

-- Rebirth is made for a screen 720 high and has its banner on the right; Til' Death, and the
-- layout used for any other theme, is made for 480.
local function themeName()
	local ok, name = pcall(function() return THEME:GetCurThemeName() end)
	return ok and type(name) == "string" and name or ""
end
local THEME_NAME = themeName()
-- "rebirth", "tildeath" or "other" (a theme whose layout is not known: the line goes bottom left).
-- Loaded from a theme's own song select, it is Til' Death or Rebirth.
local LAYOUT = THEME_NAME:lower():find("rebirth") and "rebirth" or (THEME_NAME:lower():find("^til'?%s*death") or not OVERLAY) and "tildeath" or "other"
local REBIRTH = LAYOUT == "rebirth"
local W = SCREEN_WIDTH or 854
local H = SCREEN_HEIGHT or 480
-- The line: its left end (X) or, when RIGHT is set, its right end; Y is its middle.
local X, Y, RIGHT
local MAP_X, MAP_Y, MAP_W, MAP_H
local ZOOM, GAP
if REBIRTH then
	-- In the header's empty strip under its icons, ending where its exit icon ends.
	RIGHT, Y = W - W * 38 / 1920, H * 90 / 1080
	-- The banner, at the top of the song box (it moves with the box: see placeMap).
	MAP_X, MAP_Y, MAP_W, MAP_H = W * 1140 / 1920, H * 109 / 1080, W * 780 / 1920, H * 243 / 1080
	ZOOM, GAP = 0.55, 12
elseif LAYOUT == "tildeath" then
	local s = H / 480
	X, Y = 10 * s, 50 * s
	MAP_X, MAP_Y = 10 * s, 61 * s
	MAP_W = capWideScale and capWideScale(get43size(384), 384) * s or 384 * s
	MAP_H = capWideScale and capWideScale(get43size(120), 120) * s or 120 * s
	ZOOM, GAP = 0.4 * s, 8 * s
else
	-- Bottom left, above where footers usually are; the map goes next to the line (see placeMap).
	local s = H / 480
	X, Y = 10 * s, H - 50 * s
	MAP_X, MAP_Y, MAP_W, MAP_H = 0, 0, 384 * s, 120 * s
	ZOOM, GAP = 0.4 * s, 8 * s
end
local HOME = {X = X, Y = Y, RIGHT = RIGHT}
-- Seconds to wait for the page to answer before saying it is not running.
local TIMEOUT = 6
local PAGE = "maidoffire.github.io/etterna-offset-helper"

local DIR = "/OffsetHelper/"
local REQUEST = DIR .. "request.txt"
local RESULT = DIR .. "result.txt"

-- Where the line was dragged to, per theme: a line each with the theme's name and the line's left
-- end and middle as parts of the screen's width and height, tab-separated.
local POSITIONS = DIR .. "position.txt"
local function positions()
	local list = {}
	local ok, text = pcall(File.Read, POSITIONS)
	for line in string.gmatch(ok and text or "", "[^\r\n]+") do
		local name, x, y = string.match(line, "^([^\t]+)\t([^\t]+)\t([^\t]+)$")
		if name and tonumber(x) and tonumber(y) then
			list[name] = {x = tonumber(x), y = tonumber(y)}
		end
	end
	return list
end
-- Keeps the line's place for this theme (nil: back to its usual place).
local function savePosition(x, y)
	local list = positions()
	list[THEME_NAME] = x and {x = x / W, y = y / H} or nil
	local lines = {}
	for name, p in pairs(list) do
		lines[#lines + 1] = string.format("%s\t%.4f\t%.4f", name, p.x, p.y)
	end
	table.sort(lines)
	File.Write(POSITIONS, table.concat(lines, "\n") .. (#lines > 0 and "\n" or ""))
end
do
	local p = positions()[THEME_NAME]
	if p then
		X, Y, RIGHT = p.x * W, p.y * H, nil
	end
end

-- Once per start: what this Etterna's Lua can do (LuaJIT, its compiler, its FFI), to find out
-- whether the measuring could run in game through a small native library instead of the page.
-- Written to OffsetHelper/probe.txt (the helper page shows it); nothing else changes.
local function probe()
	local lines = {}
	local function add(k, v)
		lines[#lines + 1] = k .. "=" .. tostring(v)
	end
	add("lua", _VERSION)
	if jit then
		add("jit", jit.version)
		add("os", jit.os)
		add("arch", jit.arch)
		local status = {jit.status()}
		add("compiler", status[1] and "on" or "off")
		add("compiler_flags", table.concat(status, " ", 2))
	else
		add("jit", "none")
	end
	local hasFfi, ffi = pcall(require, "ffi")
	add("ffi", hasFfi and "yes" or ("no: " .. tostring(ffi)))
	if hasFfi and jit and jit.os == "Windows" then
		local ok, err =
			pcall(
			function()
				pcall(ffi.cdef, [[
					unsigned long GetCurrentDirectoryA(unsigned long size, char* buffer);
					unsigned long GetModuleFileNameA(void* module, char* buffer, unsigned long size);
				]])
				local buffer = ffi.new("char[1024]")
				ffi.C.GetCurrentDirectoryA(1024, buffer)
				add("cwd", ffi.string(buffer))
				ffi.C.GetModuleFileNameA(nil, buffer, 1024)
				add("exe", ffi.string(buffer))
			end
		)
		add("ffi_call", ok and "works" or ("failed: " .. tostring(err)))
	end
	-- A floating-point loop like the onset curve's inner loop (short, so an interpreter does not stall the screen).
	local started = GetTimeSinceStart()
	local sum = 0
	for i = 1, 2000000 do
		sum = sum + math.sin(i * 0.001) * 0.5
	end
	add("loop_2M_ms", math.floor((GetTimeSinceStart() - started) * 1000 + 0.5))
	add("checksum", math.floor(sum))
	File.Write(DIR .. "probe.txt", table.concat(lines, "\n") .. "\n")
end

-- The native part (native/offsethelper.c): loaded once, from OffsetHelper in Etterna's folder,
-- which is remembered (root) to turn Etterna's paths into Windows ones. Etterna's Lua cannot pass
-- binary data (its file reads stop at the first zero byte), so the DLL opens the music and writes
-- the map picture itself.
--
-- The DLL and the decoded song live for the whole Etterna session, not in this screen's copy of
-- the script: when the screen goes (gameplay), the garbage collector would otherwise unload the
-- DLL and then free the song through a function in the unloaded DLL, crashing the game.
local session = OFFSETHELPER_SESSION or {}
OFFSETHELPER_SESSION = session
local ffi, lib, root, nativeError = session.ffi, session.lib, session.root, nil
local function loadNative()
	if lib or nativeError then
		return lib
	end
	local hasFfi
	hasFfi, ffi = pcall(require, "ffi")
	if not hasFfi or not jit or jit.os ~= "Windows" then
		nativeError = "no FFI on this system"
		return nil
	end
	pcall(ffi.cdef, [[
		typedef struct OhSong OhSong;
		OhSong *oh_decode_file(const char *path);
		const char *oh_error(const OhSong *song);
		double oh_duration(const OhSong *song);
		int oh_measure(OhSong *song, const double *beats, int count, double offset);
		int oh_choice_count(const OhSong *song);
		double oh_choice_offset(const OhSong *song, int i);
		double oh_choice_shift(const OhSong *song, int i);
		double oh_choice_strength(const OhSong *song, int i);
		int oh_map_range(const OhSong *song);
		int oh_map_bmp_file(OhSong *song, int width, int height, const char *path);
		void oh_free(OhSong *song);
		unsigned long GetModuleFileNameA(void *module, char *buffer, unsigned long size);
		unsigned long GetCurrentDirectoryA(unsigned long size, char *buffer);
	]])
	-- Etterna's folder is the exe's, or its parent when the exe is in Program\.
	local buffer = ffi.new("char[1024]")
	ffi.C.GetModuleFileNameA(nil, buffer, 1024)
	local exeDir = string.match(ffi.string(buffer), "^(.*)[\\/]") or "."
	ffi.C.GetCurrentDirectoryA(1024, buffer)
	local cwd = ffi.string(buffer)
	local tried = {}
	-- The helper page saves it as offsethelper.dat (Chrome will not write .dll files); the zip has .dll.
	for _, dir in ipairs({exeDir .. "\\..", exeDir, cwd .. "\\..", cwd}) do
		for _, name in ipairs({"offsethelper.dat", "offsethelper.dll"}) do
			local path = dir .. "\\OffsetHelper\\" .. name
			local ok, loaded = pcall(ffi.load, path)
			if ok then
				lib, root = loaded, dir
				session.ffi, session.lib, session.root = ffi, lib, root
				return lib
			end
			tried[#tried + 1] = path
		end
	end
	nativeError = "no offsethelper library (looked in " .. table.concat(tried, ", ") .. ")"
	return nil
end

local function mainColor(name, fallback)
	-- Til' Death has a "positive" colour; Rebirth's and other themes' colours have other names.
	if getMainColor and LAYOUT == "tildeath" then
		local ok, c = pcall(getMainColor, name)
		if ok and c ~= nil then
			return c
		end
	end
	return color(fallback)
end

local frame
-- The request being answered (page mode): { id, action, dir, since }.
local pending
-- Native mode: the decoded song kept for measuring again and its beats now are session.native.

-- Frees the decoded song (once another song is measured or selected).
local function freeNative()
	if session.native then
		session.lib.oh_free(session.native.song)
		session.native = nil
	end
end
-- What is shown for the selected song: { dir, status, text, choices = { {offset, change}, ... }, map, applied }.
local shown
local mapPath
-- Defined further down (they need the simfile helpers): remembering what Apply changed.
local fileOffset, remember, forget

local function parse(text)
	local fields = {}
	for line in string.gmatch(text or "", "[^\r\n]+") do
		local k, v = string.match(line, "^([%w_]+)=(.*)$")
		if k then
			fields[k] = v
		end
	end
	return fields
end

local function songDir()
	local song = GAMESTATE:GetCurrentSong()
	return song and song:GetSongDir() or nil
end

local function send(action, choice)
	local song = GAMESTATE:GetCurrentSong()
	if song == nil then
		return
	end
	local id = string.format("%d%04d", math.floor(GetTimeSinceStart() * 1000), math.random(0, 9999))
	local lines = {
		"id=" .. id,
		"action=" .. action,
		"dir=" .. song:GetSongDir(),
		"file=" .. (song:GetSongFilePath() or ""),
		"music=" .. (song:GetMusicPath() or "")
	}
	if choice then
		lines[#lines + 1] = "choice=" .. choice
	end
	if not File.Write(REQUEST, table.concat(lines, "\n") .. "\n") then
		shown = {dir = song:GetSongDir(), status = "error", text = "Could not write OffsetHelper/request.txt"}
		frame:playcommand("Show")
		return
	end
	pending = {id = id, action = action, dir = song:GetSongDir(), since = GetTimeSinceStart(), before = action == "apply" and fileOffset(song) or nil}
	shown = shown and shown.dir == pending.dir and shown or {dir = pending.dir}
	shown.status, shown.warn = "working", nil
	shown.text = action == "measure" and "measuring..." or action == "apply" and "applying..." or "undoing..."
	frame:playcommand("Show")
end

local function reloadSong()
	local top = SCREENMAN:GetTopScreen()
	if top and top.ReloadCurrentSong then
		top:ReloadCurrentSong()
	end
end

-- The chart's whole beats from beat 0 to past `duration`, and its offset, from Etterna's own timing.
-- GetElapsedTimeFromBeatNoOffset is the chart's timeline (beat 0 at -#OFFSET); "NoOffset" means
-- without the player's global offset, which GetElapsedTimeFromBeat also subtracts (times the rate)
-- and which has nothing to do with the chart's sync.
local function chartBeats(song, duration)
	local steps = GAMESTATE:GetCurrentSteps()
	local timing = steps and steps:GetTimingData() or song:GetTimingData()
	local beats = {}
	for b = 0, 100000 do
		local t = timing:GetElapsedTimeFromBeatNoOffset(b)
		if t > duration + 0.2 then
			break
		end
		beats[#beats + 1] = t
	end
	return beats, -timing:GetElapsedTimeFromBeatNoOffset(0)
end

-- Where a file Etterna names (/Songs/..., /AdditionalSongs/...) can be on disk: Etterna's folder,
-- or for /AdditionalSongs each of the extra song folders in its Preferences.ini.
local function diskPaths(path)
	local rest = string.gsub(string.gsub(path, "^/+", ""), "/", "\\")
	local inExtra = string.match(rest, "^[Aa]dditional[Ss]ongs\\(.*)$")
	if not inExtra then
		return {root .. "\\" .. rest}
	end
	local paths = {}
	local prefs = File.Read("/Save/Preferences.ini") or ""
	local folders = string.match(prefs, "AdditionalSongFolders=([^\r\n]*)") or ""
	for entry in string.gmatch(folders, "[^,]+") do
		local folder = string.gsub(string.gsub(entry, "^%s+", ""), "[%s\\/]+$", "")
		if folder ~= "" then
			paths[#paths + 1] = folder .. "\\" .. inExtra
		end
	end
	return paths
end

local mapCount = 0
-- The DLL's measurement as what the line shows: choices, and the sync map written as a BMP.
local function nativeResult(dir, song)
	local native = session.native
	local result = {dir = dir, status = "ready", current = string.format("%.6f", native.offset), choices = {}}
	for i = 0, lib.oh_choice_count(native.song) - 1 do
		local shift = lib.oh_choice_shift(native.song, i)
		result.choices[i + 1] = {offset = string.format("%.6f", lib.oh_choice_offset(native.song, i)), change = string.format("%+.1f", -shift), shift = shift}
	end
	result.sure = #result.choices == 1
	result.inSync = result.sure and math.abs(result.choices[1].shift) < 2
	mapCount = mapCount + 1
	local name = "map-native-" .. mapCount .. ".bmp"
	if lib.oh_map_bmp_file(native.song, 768, 240, root .. "\\OffsetHelper\\" .. name) == 0 then
		FILEMAN:FlushDirCache(DIR)
		mapPath = DIR .. name
		result.map = mapPath
		result.mapRange = lib.oh_map_range(native.song)
	end
	return result
end

local function nativeMeasure(song)
	local decoded, err
	local paths = diskPaths(song:GetMusicPath())
	for _, path in ipairs(paths) do
		decoded = lib.oh_decode_file(path)
		err = lib.oh_error(decoded)
		err = err ~= nil and ffi.string(err) or nil
		if not err then
			break
		end
		lib.oh_free(decoded)
		decoded = nil
		if not string.find(err, "cannot open", 1, true) then
			break
		end
	end
	if #paths == 0 then
		err = "no extra song folders in Save/Preferences.ini"
	end
	if err then
		if string.find(err, "cannot open", 1, true) then
			err = err .. " (" .. table.concat(paths, ", ") .. ")"
		end
		return {dir = song:GetSongDir(), status = "error", text = err}
	end
	local beats, offset = chartBeats(song, lib.oh_duration(decoded))
	freeNative()
	session.native = {dir = song:GetSongDir(), song = decoded, beats = beats, offset = offset}
	local native = session.native
	if lib.oh_measure(decoded, ffi.new("double[?]", #beats, beats), #beats, offset) ~= 0 then
		return {dir = song:GetSongDir(), status = "error", text = ffi.string(lib.oh_error(decoded))}
	end
	return nativeResult(song:GetSongDir(), song)
end

-- The song's simfiles (the one Etterna loads and any other .sm/.ssc beside it).
local function simfiles(song)
	local files, seen = {}, {}
	for _, pattern in ipairs({"*.ssc", "*.sm"}) do
		for _, path in ipairs(FILEMAN:GetDirListing(song:GetSongDir() .. pattern, false, true)) do
			if not seen[path] then
				seen[path] = true
				files[#files + 1] = path
			end
		end
	end
	return files
end

-- A simfile with its #OFFSET set to `offset` (only those digits change; chart offsets that equal
-- the song's move with it), the song's offset before, and that offset as written in the file; nil
-- when it has none. As offsetFile.ts. A string offset is written as it is (Undo puts back the
-- file's own digits).
local function withOffset(text, offset)
	local tags, pos = {}, 1
	while true do
		local a, b, value = string.find(text, "#[Oo][Ff][Ff][Ss][Ee][Tt]%s*:([^;]*);", pos)
		if not a then
			break
		end
		local lineStart = a
		while lineStart > 1 and string.sub(text, lineStart - 1, lineStart - 1) ~= "\n" do
			lineStart = lineStart - 1
		end
		local number = tonumber((string.gsub(value, "^%s*(.-)%s*$", "%1")))
		if number and not string.find(string.sub(text, lineStart, a - 1), "//", 1, true) then
			tags[#tags + 1] = {from = string.find(text, ":", a, true) + 1, to = b - 1, value = number, raw = (string.gsub(value, "^%s*(.-)%s*$", "%1"))}
		end
		pos = b + 1
	end
	if #tags == 0 then
		return nil
	end
	local old, parts, at = tags[1].value, {}, 1
	for i, tag in ipairs(tags) do
		if i == 1 or math.abs(tag.value - old) < 1e-7 then
			parts[#parts + 1] = string.sub(text, at, tag.from - 1)
			parts[#parts + 1] = type(offset) == "string" and offset or string.format("%.6f", offset)
			at = tag.to + 1
		end
	end
	parts[#parts + 1] = string.sub(text, at)
	return table.concat(parts), old, tags[1].raw
end

-- The song's offset as written in its first simfile that has one, or nil.
function fileOffset(song)
	local ok, raw =
		pcall(
		function()
			for _, path in ipairs(simfiles(song)) do
				local text = File.Read(path)
				local _, _, raw = withOffset(text or "", 0)
				if raw then
					return raw
				end
			end
		end
	)
	return ok and raw or nil
end

-- Songs whose offset Apply changed: dir -> {applied, before}, kept in OffsetHelper/synced.txt (a
-- line per song: its folder, the offset applied and the one before, tab-separated), so that the
-- line shows them with Undo after another song was selected or Etterna was restarted.
local SYNCED = DIR .. "synced.txt"
local function synced()
	if not session.synced then
		local list = {}
		local ok, text = pcall(File.Read, SYNCED)
		for line in string.gmatch(ok and text or "", "[^\r\n]+") do
			local dir, applied, before = string.match(line, "^([^\t]+)\t([^\t]+)\t([^\t]+)$")
			if dir then
				list[dir] = {applied = applied, before = before}
			end
		end
		session.synced = list
	end
	return session.synced
end
local function saveSynced()
	local lines = {}
	for dir, e in pairs(synced()) do
		lines[#lines + 1] = dir .. "\t" .. e.applied .. "\t" .. e.before
	end
	table.sort(lines)
	File.Write(SYNCED, table.concat(lines, "\n") .. (#lines > 0 and "\n" or ""))
end
function remember(dir, applied, before)
	local list = synced()
	local old = list[dir]
	-- Applied again over the offset the helper wrote: Undo still goes back to the one before that.
	if old and before and tonumber(before) and math.abs(tonumber(before) - tonumber(old.applied)) < 5e-7 then
		before = old.before
	end
	if before and applied then
		list[dir] = {applied = applied, before = before}
		saveSynced()
	end
end
function forget(dir)
	if synced()[dir] then
		synced()[dir] = nil
		saveSynced()
	end
end

local function nativeApply(song, choice)
	local native = session.native
	if not native or native.dir ~= song:GetSongDir() or not shown or not shown.choices or not shown.choices[choice] then
		return {dir = song:GetSongDir(), status = "error", text = "press Sync first"}
	end
	local offset = tonumber(shown.choices[choice].offset)
	local current = tonumber(shown.current)
	local undo, written = {}, 0
	for _, path in ipairs(simfiles(song)) do
		local text = File.Read(path)
		local changed, old
		if text then
			changed, old = withOffset(text, offset)
		end
		-- A simfile whose offset is not the one measured (changed meanwhile, or a different file) stays.
		if changed and math.abs(old - current) < 5e-7 and File.Write(path, changed) then
			undo[#undo + 1] = {path = path, text = text}
			written = written + 1
		end
	end
	if written == 0 then
		return {dir = song:GetSongDir(), status = "error", warn = true, text = "the offset in the file changed: press Sync again"}
	end
	-- The map again with the new offset, centred when the fix was right.
	local shift = (native.offset - offset)
	local moved = {}
	for i, t in ipairs(native.beats) do
		moved[i] = t + shift
	end
	local result = shown
	if lib.oh_measure(native.song, ffi.new("double[?]", #moved, moved), #moved, offset) == 0 then
		result = nativeResult(song:GetSongDir(), song)
	end
	result.undo = undo
	result.applied = string.format("%.6f", offset)
	result.status = "applied"
	result.choices = shown.choices
	result.current = shown.current
	result.sure = shown.sure
	result.inSync = shown.inSync
	return result
end

local function nativeUndo(song)
	local native = session.native
	if not shown or not shown.undo then
		return shown
	end
	-- Only files that still have the offset applied go back (one changed meanwhile stays).
	local restored = 0
	for _, file in ipairs(shown.undo) do
		local _, now = withOffset(File.Read(file.path) or "", 0)
		if now and math.abs(now - tonumber(shown.applied)) < 5e-7 and File.Write(file.path, file.text) then
			restored = restored + 1
		end
	end
	if restored == 0 then
		forget(song:GetSongDir())
		return {dir = song:GetSongDir(), status = "error", warn = true, text = "the offset was changed since: nothing undone"}
	end
	if native and native.dir == song:GetSongDir() then
		lib.oh_measure(native.song, ffi.new("double[?]", #native.beats, native.beats), #native.beats, native.offset)
		local result = nativeResult(song:GetSongDir(), song)
		result.status = "restored"
		return result
	end
	shown.undo, shown.applied, shown.status = nil, nil, "restored"
	return shown
end

-- Measuring, applying and undoing with the DLL: the line first says what it is doing, the work
-- happens on the next frame.
local function runNative(action, choice)
	local song = GAMESTATE:GetCurrentSong()
	if song == nil then
		return
	end
	shown = shown and shown.dir == song:GetSongDir() and shown or {dir = song:GetSongDir()}
	local before = shown
	local fileBefore = action == "apply" and fileOffset(song) or nil
	shown.status, shown.warn = "working", nil
	shown.text = action == "measure" and "measuring..." or action == "apply" and "applying..." or "undoing..."
	frame:playcommand("Show")
	frame.nativeWork = function()
		local ok, result =
			pcall(
			function()
				if action == "measure" then
					return nativeMeasure(song)
				elseif action == "apply" then
					return nativeApply(song, choice)
				end
				return nativeUndo(song)
			end
		)
		if not ok then
			result = {dir = song:GetSongDir(), status = "error", text = tostring(result)}
		end
		if result.status == "error" and before.choices and action ~= "measure" then
			before.status, before.text, before.warn = "error", result.text, result.warn
			result = before
		end
		shown = result
		if result.status == "applied" then
			remember(song:GetSongDir(), result.applied, fileBefore)
		elseif result.status == "restored" then
			forget(song:GetSongDir())
		end
		if result.status == "applied" or result.status == "restored" then
			reloadSong()
		end
		frame:playcommand("Show")
	end
	frame:sleep(0.02):queuecommand("Native")
end

-- Undo for a song applied before it was selected this time (or in an earlier run): the offset
-- from before goes back into each simfile that still has the one applied. No DLL or page needed.
local function undoRemembered(song)
	local dir = song:GetSongDir()
	local e = synced()[dir]
	if not e then
		return
	end
	local written = 0
	for _, path in ipairs(simfiles(song)) do
		local text = File.Read(path)
		local changed, old
		if text then
			changed, old = withOffset(text, e.before)
		end
		if changed and math.abs(old - tonumber(e.applied)) < 5e-7 and File.Write(path, changed) then
			written = written + 1
		end
	end
	forget(dir)
	if written == 0 then
		shown = {dir = dir, status = "error", warn = true, text = "the offset was changed since: nothing undone"}
	else
		shown = {dir = dir, status = "restored", current = e.before}
		reloadSong()
	end
	frame:playcommand("Show")
end

-- Sync, Apply and Undo: with the DLL when it loads, else through the page.
local function act(action, choice)
	local song = GAMESTATE:GetCurrentSong()
	if action == "undo" and song and shown and shown.remembered and shown.dir == song:GetSongDir() then
		undoRemembered(song)
	elseif loadNative() then
		runNative(action, choice)
	else
		send(action, choice)
	end
end

-- The page's answer to the pending request, once it is there.
local function checkResult()
	if not pending then
		return
	end
	local r = parse(File.Read(RESULT))
	local waited = GetTimeSinceStart() - pending.since
	if (r.id ~= pending.id and waited > TIMEOUT) or (r.status == "busy" and waited > 10 * TIMEOUT) then
		shown = {dir = pending.dir, status = "error", text = "No answer: open " .. PAGE .. " in Chrome or Edge and keep it open"}
		pending = nil
		frame:playcommand("Show")
		return
	end
	if r.id ~= pending.id or r.status == "busy" then
		return
	end
	local dir, before = pending.dir, pending.before
	pending = nil
	shown = shown and shown.dir == dir and shown or {dir = dir}
	shown.status = r.status
	shown.text = r.message
	shown.warn = r.warn == "1"
	if r.map and r.map ~= "" then
		FILEMAN:FlushDirCache(DIR)
		mapPath = r.map
		shown.map = r.map
	end
	if r.status == "ready" then
		shown.current = r.current
		shown.choices = {}
		local i = 1
		while r["choice" .. i] do
			local offset, change = string.match(r["choice" .. i], "^(%S+) (%S+)")
			shown.choices[i] = {offset = offset, change = change}
			i = i + 1
		end
		shown.sure = r.sure == "1"
		shown.inSync = r.insync == "1"
		shown.applied = nil
	elseif r.status == "applied" then
		shown.applied = r.offset
		remember(dir, r.offset, before)
		reloadSong()
	elseif r.status == "restored" then
		shown.applied = nil
		forget(dir)
		reloadSong()
	end
	frame:playcommand("Show")
end

-- The mouse is over an actor (its zoomed box, wherever its parents put it).
local function over(a)
	if a == nil or not a:GetVisible() then
		return false
	end
	local mx, my = INPUTFILTER:GetMouseX(), INPUTFILTER:GetMouseY()
	local w, h = a:GetZoomedWidth(), a:GetZoomedHeight()
	local left = a:GetTrueX() - w * a:GetHAlign()
	local top = a:GetTrueY() - h * a:GetVAlign()
	return mx >= left and mx <= left + w and my >= top and my <= top + h
end

-- Text pieces of the line, left to right: label, Sync, the result, then up to three buttons.
local BUTTONS = {"Sync", "B1", "B2", "B3"}
local pieces = {"Label", "Sync", "Info", "B1", "B2", "B3"}
local actions = {}

local function piece(name, isButton)
	return LoadFont("Common Normal") .. {
		Name = name,
		InitCommand = function(self)
			self:halign(0):valign(0.5):zoom(ZOOM):settext("")
			self:diffuse(isButton and mainColor("positive", "#9bd7ff") or color("#ffffff"))
		end
	}
end

-- Rebirth's banner moves with its song box (to the left with the wheel on the right, away while
-- the profile pages are open), so the map follows the box's frame when there is one. Etterna
-- moves a screen's decorations into the screen itself, so the box is a child of the screen.
local function placeMap(root)
	local x, y
	if REBIRTH then
		local box = SCREENMAN:GetTopScreen()
		for _, name in ipairs({"RightFrame", "CurSongBoxFile", "Frame"}) do
			box = box and box.GetChild and box:GetChild(name)
		end
		if box then
			x, y = box:GetTrueX(), box:GetTrueY()
		end
	elseif LAYOUT == "other" then
		-- Next to the line: above it in the lower half of the screen, below it in the upper half.
		local lx, ly = frame:GetTrueX(), frame:GetTrueY()
		x = math.max(0, math.min(lx, W - MAP_W))
		y = ly > H / 2 and ly - 12 * H / 480 - MAP_H or ly + 12 * H / 480
	end
	if x then
		root:GetChild("OffsetHelperMap"):xy(x, y)
		root:GetChild("OffsetHelperLabels"):xy(x, y)
	end
end

-- Til' Death (and themes made from it) draws its other tabs (scores, MSD, search, profile, ...)
-- over the place where the line and the map go, so they show only on its General tab. Rebirth's
-- line is in its header, which every page keeps.
local function onGeneralTab()
	return REBIRTH or getTabIndex == nil or getTabIndex() == 0
end

-- As an overlay the line is there on every screen: it shows only while song select (or the
-- multiplayer one, made from it) is the screen on top, not over options, gameplay or results.
local function onSongSelect()
	if not OVERLAY then
		return true
	end
	local top = SCREENMAN:GetTopScreen()
	return top ~= nil and top.GetMusicWheel ~= nil
end

local function wanted()
	return songDir() ~= nil and onSongSelect() and onGeneralTab()
end

-- The screen that takes this line's input callback: the overlay screen it is in (overlay screens
-- get input before the screen under them), or the song select screen it was loaded from.
local function ownScreen(actor)
	local a = actor
	while a do
		if a.AddInputCallback then
			return a
		end
		a = a:GetParent()
	end
	return SCREENMAN:GetTopScreen()
end

-- The "Offset:" word being dragged: where the mouse took hold of the line.
local dragging

local LEFT = "DeviceButton_left mouse button"
local RIGHT_BUTTON = "DeviceButton_right mouse button"

local t =
	Def.ActorFrame {
	Name = "OffsetHelperLine",
	InitCommand = function(self)
		frame = self
		self:xy(X or RIGHT, Y)
	end,
	OnCommand = function(self)
		if not OFFSETHELPER_PROBED then
			OFFSETHELPER_PROBED = true
			pcall(probe)
		end
		local screen = ownScreen(self)
		if screen and screen.AddInputCallback then
			screen:AddInputCallback(
				function(event)
					local button = event.DeviceInput.button
					if event.type == "InputEventType_Release" and button == LEFT and dragging then
						dragging = nil
						savePosition(X, Y)
						return true
					end
					if event.type ~= "InputEventType_FirstPress" or not self:GetVisible() then
						return false
					end
					local label = self:GetChild("Label")
					if button == RIGHT_BUTTON and over(label) then
						X, Y, RIGHT = HOME.X, HOME.Y, HOME.RIGHT
						savePosition(nil)
						self:xy(X or RIGHT, Y)
						self:playcommand("Show")
						return true
					end
					if button ~= LEFT then
						return false
					end
					for _, name in ipairs(BUTTONS) do
						local a = self:GetChild(name)
						if actions[name] and over(a) then
							actions[name]()
							return true
						end
					end
					if over(label) then
						dragging = {dx = INPUTFILTER:GetMouseX() - self:GetX(), dy = INPUTFILTER:GetMouseY() - self:GetY()}
						return true
					end
					return false
				end
			)
		end
		self:SetUpdateFunction(
			function(self)
				if OVERLAY and wanted() ~= self:GetVisible() then
					self:playcommand("Show")
				end
				if dragging then
					X = math.max(0, math.min(INPUTFILTER:GetMouseX() - dragging.dx, W - 40))
					Y = math.max(0, math.min(INPUTFILTER:GetMouseY() - dragging.dy, H))
					RIGHT = nil
					self:xy(X, Y)
				end
				-- Buttons light up under the mouse, the "Offset:" word too (it can be dragged); the
				-- sync map shows while the result is hovered.
				for _, name in ipairs(BUTTONS) do
					local a = self:GetChild(name)
					a:diffusealpha((actions[name] and self:GetVisible() and over(a)) and 0.6 or 1)
				end
				local label = self:GetChild("Label")
				label:diffusealpha((dragging or (self:GetVisible() and over(label))) and 0.6 or 1)
				local map = self:GetParent():GetChild("OffsetHelperMap")
				if map then
					local visible = mapPath ~= nil and shown ~= nil and shown.map == mapPath and shown.dir == songDir() and self:GetVisible() and over(self:GetChild("Info"))
					if visible then
						placeMap(self:GetParent())
					end
					map:visible(visible)
					self:GetParent():GetChild("OffsetHelperLabels"):visible(visible and shown.mapRange ~= nil)
				end
				if pending and GetTimeSinceStart() - (self.lastCheck or 0) >= 0.25 then
					self.lastCheck = GetTimeSinceStart()
					checkResult()
				end
			end
		)
		self:SetUpdateFunctionInterval(0.02)
		self:playcommand("Show")
	end,
	CurrentSongChangedMessageCommand = function(self)
		-- The decoded song goes once another song is selected.
		if session.native and session.native.dir ~= songDir() then
			freeNative()
		end
		self:playcommand("Show")
	end,
	NativeCommand = function(self)
		local work = self.nativeWork
		self.nativeWork = nil
		if work then
			work()
		end
	end,
	TabChangedMessageCommand = function(self)
		self:playcommand("Show")
	end,
	ScreenChangedMessageCommand = function(self)
		self:playcommand("Show")
	end,
	ShowCommand = function(self)
		local dir = songDir()
		self:visible(wanted())
		if dir == nil then
			return
		end
		if not (shown and shown.dir == dir) and synced()[dir] then
			shown = {dir = dir, status = "remembered", applied = synced()[dir].applied, remembered = true}
		end
		local s = shown and shown.dir == dir and shown or nil
		local texts = {Label = "Offset:", Sync = "Sync", Info = "", B1 = "", B2 = "", B3 = ""}
		actions = {Sync = function() act("measure") end}
		if s and s.status == "working" then
			texts.Info = s.text
			actions.Sync = nil
		elseif s and s.status == "error" then
			texts.Info = s.text or "something went wrong"
		elseif s and s.applied then
			texts.Info = "applied " .. s.applied
			texts.B1 = "Undo"
			actions.B1 = function() act("undo") end
		elseif s and s.status == "restored" then
			texts.Info = "restored " .. (s.current or "")
		elseif s and s.choices and #s.choices > 0 then
			local c = s.choices[1]
			if s.sure then
				texts.Info = s.inSync and ("in sync (" .. c.change .. " ms)") or (c.change .. " ms -> " .. c.offset)
				texts.B1 = "Apply"
				actions.B1 = function() act("apply", 1) end
				-- Synced again after an earlier Apply: that one can still be undone.
				if synced()[dir] then
					texts.B2 = "Undo"
					actions.B2 = function()
						local song = GAMESTATE:GetCurrentSong()
						if song then
							undoRemembered(song)
						end
					end
				end
			else
				texts.Info = "not sure, beat at:"
				for i = 1, math.min(3, #s.choices) do
					texts["B" .. i] = i .. ": " .. s.choices[i].change .. " ms"
					actions["B" .. i] = function() act("apply", i) end
				end
			end
		end
		local x = 0
		for _, name in ipairs(pieces) do
			local a = self:GetChild(name)
			a:settext(texts[name])
			a:x(x)
			if texts[name] ~= "" then
				x = x + a:GetZoomedWidth() + GAP
			end
		end
		if RIGHT then
			self:x(RIGHT - (x - GAP))
		end
		-- Red for failures; amber when nothing was written because the file changed meanwhile.
		local info = color("#ffffff")
		if s and s.status == "error" then
			info = s.warn and color("#d9a64a") or color("#e06c6c")
		end
		self:GetChild("Info"):diffuse(info)
		local map = self:GetParent():GetChild("OffsetHelperMap")
		if map and mapPath and map.loaded ~= mapPath then
			map:Load(mapPath)
			map:zoomto(MAP_W, MAP_H)
			map.loaded = mapPath
		end
		-- The DLL's map has no text: its ms lines are labelled here.
		local range = s and s.mapRange
		if range then
			local values = range == 60 and {-30, -10, 10, 30} or {-75, -50, -25, 25, 50, 75}
			local labels = self:GetParent():GetChild("OffsetHelperLabels")
			for i = 1, 6 do
				local label = labels:GetChild("L" .. i)
				local v = values[i]
				label:visible(v ~= nil)
				if v then
					label:settext((v > 0 and "+" or "-") .. math.abs(v))
					label:y(MAP_H / 2 - v / range * (MAP_H / 2))
				end
			end
		end
	end
}

for _, name in ipairs(pieces) do
	local isButton = false
	for _, b in ipairs(BUTTONS) do
		if b == name then
			isButton = true
		end
	end
	t[#t + 1] = piece(name, isButton)
end

-- The sync map, over the banner while the result is hovered, with its ms labels.
local labels = Def.ActorFrame {Name = "OffsetHelperLabels", InitCommand = function(self) self:xy(MAP_X, MAP_Y):visible(false) end}
for i = 1, 6 do
	labels[#labels + 1] = LoadFont("Common Normal") .. {
		Name = "L" .. i,
		InitCommand = function(self)
			self:x(3 * H / 480):halign(0):valign(0.5):zoom(0.3 * H / 480):diffuse(color("#ffffff")):diffusealpha(0.6)
		end
	}
end

return Def.ActorFrame {
	Def.Sprite {
		Name = "OffsetHelperMap",
		InitCommand = function(self)
			self:xy(MAP_X, MAP_Y):halign(0):valign(0):visible(false)
		end
	},
	labels,
	t
}
