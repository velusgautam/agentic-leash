!macro customInstall
  DetailPrint "Registering Agentic Leash Activity Helper Windows Service..."
  ExecWait 'sc.exe create AgenticLeashHelper binPath= "\"$INSTDIR\Agentic Leash.exe\" \"$INSTDIR\resources\app.asar.unpacked\out\main\leash-helper.js\"" start= auto DisplayName= "Agentic Leash Activity Helper"'
  ExecWait 'sc.exe start AgenticLeashHelper'
!macroend

!macro customUnInstall
  DetailPrint "Removing Agentic Leash Activity Helper Windows Service..."
  ExecWait 'sc.exe stop AgenticLeashHelper'
  ExecWait 'sc.exe delete AgenticLeashHelper'
!macroend
