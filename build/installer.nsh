!macro customUnInstallSection
  Section /o "un.同时清除 LabDeck 本机配置与数据" SEC_DELETE_LABDECK_USER_DATA
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endIf}

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif
    !ifdef APP_PACKAGE_NAME
      RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    !endif

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endIf}
  SectionEnd
!macroend
