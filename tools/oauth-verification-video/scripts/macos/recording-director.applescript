on requireArgument(argv, argumentIndex, labelText)
	if (count of argv) < argumentIndex then error labelText & " is required"
	return item argumentIndex of argv
end requireArgument

on safeCommandFile(commandPath)
	if commandPath contains return or commandPath contains linefeed then error "Unsafe command file path"
	if commandPath does not contain "/tools/oauth-verification-video/.work/live/" then error "Command file must be below .work/live"
	if commandPath does not end with ".zsh" then error "Command file must have a .zsh suffix"
	return commandPath
end safeCommandFile

on safeUrl(urlText)
	if urlText contains return or urlText contains linefeed then error "Unsafe URL"
	set allowedPrefixes to {"https://oauth.usejunior.com/api/start?", "https://usejunior.com/", "https://console.cloud.google.com/", "https://mail.google.com/", "https://myaccount.google.com/", "https://github.com/UseJunior/email-agent-mcp/"}
	repeat with allowedPrefix in allowedPrefixes
		if urlText starts with (contents of allowedPrefix) then return urlText
	end repeat
	error "URL is outside the recording allowlist"
end safeUrl

on safeCaptureFile(capturePath)
	if capturePath contains return or capturePath contains linefeed then error "Unsafe capture path"
	if capturePath does not contain "/tools/oauth-verification-video/captures/" then error "Capture must be below the ignored captures directory"
	if capturePath does not end with ".mov" then error "Capture must have a .mov suffix"
	return capturePath
end safeCaptureFile

on run argv
	set actionName to my requireArgument(argv, 1, "action")

	if actionName is "terminal-file" then
		set commandPath to my safeCommandFile(my requireArgument(argv, 2, "command file"))
		tell application "Terminal"
			activate
			do script ("/bin/zsh " & quoted form of commandPath)
			set bounds of front window to {24, 42, 1320, 1000}
		end tell
		return "started"
	else if actionName is "terminal-contents" then
		tell application "Terminal"
			if (count of windows) is 0 then error "Terminal has no open window"
			return contents of selected tab of front window
		end tell
	else if actionName is "open-url" then
		set urlText to my safeUrl(my requireArgument(argv, 2, "URL"))
		open location urlText
		return "opened"
	else if actionName is "activate-terminal" then
		tell application "Terminal" to activate
		return "activated"
	else if actionName is "activate-browser" then
		tell application "Google Chrome" to activate
		return "activated"
	else if actionName is "review-capture" then
		set capturePath to my safeCaptureFile(my requireArgument(argv, 2, "capture path"))
		tell application "QuickTime Player"
			activate
			open POSIX file capturePath
		end tell
		return "opened"
	else
		error "Unknown recording-director action"
	end if
end run
