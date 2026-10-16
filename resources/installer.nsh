; ---------------------------------------------------------------------------
; Custom "is the app already running?" check for the Jw Knowledge Base
; installer (referenced from electron-builder.yml -> nsis.include).
;
; WHY THIS FILE EXISTS
;
; electron-builder's stock implementation of this check lives in
; templates/nsis/include/allowOnlyOneInstallerInstance.nsh. It shells out to
; PowerShell through nsExec::Exec (twice, at startup and again before copying
; files). nsExec needs a temporary file to capture the child process output,
; and on some machines that step fails with a modal error, aborting the
; installer before it ever shows its window:
;
;   NSIS Error
;   Error writing temporary file. Make sure your temp folder is valid.
;
; By defining customCheckAppRunning here we replace that implementation with
; an empty macro, so installation no longer depends on PowerShell and no
; longer writes temporary files at all.
;
; TRADE-OFF: the installer no longer offers to close a running copy of the
; app. This is a single-user, single-machine desktop tool - just close
; Jw Knowledge Base before reinstalling/updating.
;
; NOTE: keep this file ASCII-only. The NSIS compiler reads include files using
; the system code page, so non-ASCII text here is a compile-time risk; the
; explanation for humans lives in README.md instead.
; ---------------------------------------------------------------------------

!macro customCheckAppRunning
!macroend
