-- Etterna offset helper, in-game part: https://maidoffire.github.io/etterna-offset-helper/
--
-- A line above the banner on song select. Sync measures the selected song's offset, Apply writes
-- the recommended one and reloads the song. Hovering the result shows the sync map over the
-- banner. The measuring is done by OffsetHelper/offsethelper.dat (or .dll), loaded through LuaJIT's FFI:
-- it decodes the music as Etterna plays it and measures it as the helper page does. Without the
-- DLL, the helper page does it (open in Chrome or Edge): this file and the page then talk through
-- OffsetHelper/request.txt and OffsetHelper/result.txt in the Etterna folder.
--
-- Installed by the helper page (it also removes it again). To move the line, change X and Y.

local X, Y = 10, 50
local MAP_X, MAP_Y = 10, 61
local MAP_W = capWideScale(get43size(384), 384)
local MAP_H = capWideScale(get43size(120), 120)
local ZOOM = 0.4
local GAP = 8
-- Seconds to wait for the page to answer before saying it is not running.
local TIMEOUT = 6
local PAGE = "maidoffire.github.io/etterna-offset-helper"

local DIR = "/OffsetHelper/"
local REQUEST = DIR .. "request.txt"
local RESULT = DIR .. "result.txt"

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

-- The native part (native/offsethelper.c): loaded once, from OffsetHelper in Etterna's folder.
local ffi, lib, nativeError
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
		OhSong *oh_decode(const char *data, int size);
		const char *oh_error(const OhSong *song);
		double oh_duration(const OhSong *song);
		int oh_measure(OhSong *song, const double *beats, int count, double offset);
		int oh_choice_count(const OhSong *song);
		double oh_choice_offset(const OhSong *song, int i);
		double oh_choice_shift(const OhSong *song, int i);
		double oh_choice_strength(const OhSong *song, int i);
		int oh_map_bmp(OhSong *song, int width, int height, const unsigned char **bytes);
		int oh_map_range(const OhSong *song);
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
				lib = loaded
				return lib
			end
			tried[#tried + 1] = path
		end
	end
	nativeError = "no offsethelper library (looked in " .. table.concat(tried, ", ") .. ")"
	return nil
end

local function mainColor(name, fallback)
	if getMainColor then
		return getMainColor(name)
	end
	return color(fallback)
end

local frame
-- The request being answered (page mode): { id, action, dir, since }.
local pending
-- Native mode: the decoded song kept for measuring again, its beats now, and the simfiles as they were.
local native
-- What is shown for the selected song: { dir, status, text, choices = { {offset, change}, ... }, map, applied }.
local shown
local mapPath

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
	pending = {id = id, action = action, dir = song:GetSongDir(), since = GetTimeSinceStart()}
	shown = shown and shown.dir == pending.dir and shown or {dir = pending.dir}
	shown.status = "working"
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
local function chartBeats(song, duration)
	local steps = GAMESTATE:GetCurrentSteps()
	local timing = steps and steps:GetTimingData() or song:GetTimingData()
	local beats = {}
	for b = 0, 100000 do
		local t = timing:GetElapsedTimeFromBeat(b)
		if t > duration + 0.2 then
			break
		end
		beats[#beats + 1] = t
	end
	return beats, timing:GetElapsedTimeFromBeatNoOffset(0) - timing:GetElapsedTimeFromBeat(0)
end

local mapCount = 0
-- The DLL's measurement as what the line shows: choices, and the sync map written as a BMP.
local function nativeResult(dir, song)
	local result = {dir = dir, status = "ready", current = string.format("%.6f", native.offset), choices = {}}
	for i = 0, lib.oh_choice_count(native.song) - 1 do
		local shift = lib.oh_choice_shift(native.song, i)
		result.choices[i + 1] = {offset = string.format("%.6f", lib.oh_choice_offset(native.song, i)), change = string.format("%+.1f", -shift), shift = shift}
	end
	result.sure = #result.choices == 1
	result.inSync = result.sure and math.abs(result.choices[1].shift) < 2
	local bytes = ffi.new("const unsigned char*[1]")
	local size = lib.oh_map_bmp(native.song, 768, 240, bytes)
	if size > 0 then
		mapCount = mapCount + 1
		local path = DIR .. "map-native-" .. mapCount .. ".bmp"
		if File.Write(path, ffi.string(bytes[0], size)) then
			FILEMAN:FlushDirCache(DIR)
			mapPath = path
			result.mapRange = lib.oh_map_range(native.song)
		end
	end
	return result
end

local function nativeMeasure(song)
	local data = File.Read(song:GetMusicPath())
	if not data then
		return {dir = song:GetSongDir(), status = "error", text = "could not read the music file"}
	end
	local decoded = ffi.gc(lib.oh_decode(data, #data), lib.oh_free)
	local err = lib.oh_error(decoded)
	if err ~= nil then
		return {dir = song:GetSongDir(), status = "error", text = ffi.string(err)}
	end
	local beats, offset = chartBeats(song, lib.oh_duration(decoded))
	native = {dir = song:GetSongDir(), song = decoded, beats = beats, offset = offset}
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
-- the song's move with it), and the song's offset before; nil when it has none. As offsetFile.ts.
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
			tags[#tags + 1] = {from = string.find(text, ":", a, true) + 1, to = b - 1, value = number}
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
			parts[#parts + 1] = string.format("%.6f", offset)
			at = tag.to + 1
		end
	end
	parts[#parts + 1] = string.sub(text, at)
	return table.concat(parts), old
end

local function nativeApply(song, choice)
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
		return {dir = song:GetSongDir(), status = "error", text = "the offset in the file changed: press Sync again"}
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
	if not shown or not shown.undo then
		return shown
	end
	for _, file in ipairs(shown.undo) do
		File.Write(file.path, file.text)
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
	shown.status = "working"
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
			before.status, before.text = "error", result.text
			result = before
		end
		shown = result
		if result.status == "applied" or result.status == "restored" then
			reloadSong()
		end
		frame:playcommand("Show")
	end
	frame:sleep(0.02):queuecommand("Native")
end

-- Sync, Apply and Undo: with the DLL when it loads, else through the page.
local function act(action, choice)
	if loadNative() then
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
	local dir = pending.dir
	pending = nil
	shown = shown and shown.dir == dir and shown or {dir = dir}
	shown.status = r.status
	shown.text = r.message
	if r.map and r.map ~= "" then
		FILEMAN:FlushDirCache(DIR)
		mapPath = r.map
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
		reloadSong()
	elseif r.status == "restored" then
		shown.applied = nil
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

local t =
	Def.ActorFrame {
	InitCommand = function(self)
		frame = self
		self:xy(X, Y)
	end,
	OnCommand = function(self)
		if not OFFSETHELPER_PROBED then
			OFFSETHELPER_PROBED = true
			pcall(probe)
		end
		local screen = SCREENMAN:GetTopScreen()
		if screen and screen.AddInputCallback then
			screen:AddInputCallback(
				function(event)
					if event.type ~= "InputEventType_FirstPress" or event.DeviceInput.button ~= "DeviceButton_left mouse button" then
						return false
					end
					for _, name in ipairs(BUTTONS) do
						local a = self:GetChild(name)
						if actions[name] and over(a) then
							actions[name]()
							return true
						end
					end
					return false
				end
			)
		end
		self:SetUpdateFunction(
			function(self)
				-- Buttons light up under the mouse; the sync map shows while the result is hovered.
				for _, name in ipairs(BUTTONS) do
					local a = self:GetChild(name)
					a:diffusealpha((actions[name] and over(a)) and 0.6 or 1)
				end
				local map = self:GetParent():GetChild("OffsetHelperMap")
				if map then
					local visible = mapPath ~= nil and shown ~= nil and shown.dir == songDir() and over(self:GetChild("Info"))
					map:visible(visible)
					self:GetParent():GetChild("OffsetHelperLabels"):visible(visible and shown.mapRange ~= nil)
				end
				self.sinceCheck = (self.sinceCheck or 0) + 1
				if pending and self.sinceCheck >= 5 then
					self.sinceCheck = 0
					checkResult()
				end
			end
		)
		self:SetUpdateFunctionInterval(0.05)
		self:playcommand("Show")
	end,
	CurrentSongChangedMessageCommand = function(self)
		-- The decoded song goes once another song is selected.
		if native and native.dir ~= songDir() then
			native = nil
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
	ShowCommand = function(self)
		local dir = songDir()
		self:visible(dir ~= nil)
		if dir == nil then
			return
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
		self:GetChild("Info"):diffuse(s and s.status == "error" and color("#e06c6c") or color("#ffffff"))
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
					label:y(MAP_Y + MAP_H / 2 - v / range * (MAP_H / 2))
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
local labels = Def.ActorFrame {Name = "OffsetHelperLabels", InitCommand = function(self) self:visible(false) end}
for i = 1, 6 do
	labels[#labels + 1] = LoadFont("Common Normal") .. {
		Name = "L" .. i,
		InitCommand = function(self)
			self:x(MAP_X + 3):halign(0):valign(0.5):zoom(0.3):diffuse(color("#ffffff")):diffusealpha(0.6)
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
