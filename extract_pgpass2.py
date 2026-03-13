import subprocess
import re

# Read Windows Credential Manager for postgres-related entries
result = subprocess.run(
    ['cmdkey', '/list'],
    capture_output=True, text=True
)

print("=== Windows Credential Manager ===")
print(result.stdout)

# Also try with PowerShell to get more detail
ps_cmd = '''
[void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]
$vault = New-Object Windows.Security.Credentials.PasswordVault
try {
    $creds = $vault.RetrieveAll()
    foreach ($c in $creds) {
        $c.RetrievePassword()
        Write-Output "Resource: $($c.Resource) | User: $($c.UserName) | Pass: $($c.Password)"
    }
} catch {
    Write-Output "No credentials found or access denied: $_"
}
'''

result2 = subprocess.run(
    ['powershell', '-Command', ps_cmd],
    capture_output=True, text=True
)
print("=== Password Vault ===")
print(result2.stdout)
if result2.stderr:
    print("Errors:", result2.stderr[:500])
