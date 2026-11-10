#!/bin/sh
# Packs the probe as a VSIX without vsce/network (a VSIX is a zip with a manifest), for testing in a normal window:
#   ./make-vsix.sh && code --install-extension /tmp/searchie-spike/searchie-s1-probe.vsix
#   ... test ...   && code --uninstall-extension searchie-spike.searchie-s1-probe
set -e
cd "$(dirname "$0")"
OUT=/tmp/searchie-spike/searchie-s1-probe.vsix
python3 - "$OUT" <<'EOF'
import sys, zipfile
out = sys.argv[1]
manifest = '''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="searchie-s1-probe" Version="0.0.1" Publisher="searchie-spike" />
    <DisplayName>Searchie S1 Probe (spike)</DisplayName>
    <Description xml:space="preserve">Throwaway probe for opening chat sessions</Description>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.106.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation>
  <Dependencies/>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /></Assets>
</PackageManifest>
'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json"/><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>
'''
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('extension.vsixmanifest', manifest)
    z.write('package.json', 'extension/package.json')
    z.write('extension.js', 'extension/extension.js')
print(out)
EOF
