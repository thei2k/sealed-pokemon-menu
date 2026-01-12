$KeyPath = "$env:thei2\Downloads\ssh-key-2026-01-12.key"
$User = "ubuntu"
$Host = "129.80.128.13"

Start-Process powershell -ArgumentList "-NoExit", "-Command", "ssh -i `"$KeyPath`" $User@$Host"
