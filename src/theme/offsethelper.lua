-- Etterna offset helper, in-game part: https://maidoffire.github.io/etterna-offset-helper/
--
-- A line above the banner on song select. Sync measures the selected song's offset, Apply writes
-- the recommended one and reloads the song. Hovering the result shows the sync map over the
-- banner. Etterna's Lua cannot read audio, so the measuring is done by the helper page, which must
-- be open in Chrome or Edge: this file and the page talk through OffsetHelper/request.txt and
-- OffsetHelper/result.txt in the Etterna folder.
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

local function mainColor(name, fallback)
	if getMainColor then
		return getMainColor(name)
	end
	return color(fallback)
end

local frame
-- The request being answered: { id, action, dir, since }.
local pending
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
					map:visible(mapPath ~= nil and shown ~= nil and shown.dir == songDir() and over(self:GetChild("Info")))
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
		self:playcommand("Show")
	end,
	ShowCommand = function(self)
		local dir = songDir()
		self:visible(dir ~= nil)
		if dir == nil then
			return
		end
		local s = shown and shown.dir == dir and shown or nil
		local texts = {Label = "Offset:", Sync = "Sync", Info = "", B1 = "", B2 = "", B3 = ""}
		actions = {Sync = function() send("measure") end}
		if s and s.status == "working" then
			texts.Info = s.text
			actions.Sync = nil
		elseif s and s.status == "error" then
			texts.Info = s.text or "something went wrong"
		elseif s and s.applied then
			texts.Info = "applied " .. s.applied
			texts.B1 = "Undo"
			actions.B1 = function() send("undo") end
		elseif s and s.status == "restored" then
			texts.Info = "restored " .. (s.current or "")
		elseif s and s.choices and #s.choices > 0 then
			local c = s.choices[1]
			if s.sure then
				texts.Info = s.inSync and ("in sync (" .. c.change .. " ms)") or (c.change .. " ms -> " .. c.offset)
				texts.B1 = "Apply"
				actions.B1 = function() send("apply", 1) end
			else
				texts.Info = "not sure, beat at:"
				for i = 1, math.min(3, #s.choices) do
					texts["B" .. i] = i .. ": " .. s.choices[i].change .. " ms"
					actions["B" .. i] = function() send("apply", i) end
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

-- The sync map, over the banner while the result is hovered.
return Def.ActorFrame {
	Def.Sprite {
		Name = "OffsetHelperMap",
		InitCommand = function(self)
			self:xy(MAP_X, MAP_Y):halign(0):valign(0):visible(false)
		end
	},
	t
}
