// Rufa NSIS helper: give only the old uninstaller a private, same-volume TEMP.
// No global or parent environment changes; no changes to native rollback code.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <objbase.h>
#include <commctrl.h>
#include <algorithm>
#include <string>
#include <vector>

struct Stack { Stack* next; wchar_t text[1]; };
struct Handle {
  HANDLE value = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE h = INVALID_HANDLE_VALUE) : value(h) {}
  ~Handle() { if (value != INVALID_HANDLE_VALUE && value != nullptr) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  bool valid() const { return value != INVALID_HANDLE_VALUE && value != nullptr; }
};
struct WaitingProgress {
  HWND bar = nullptr;
  LONG_PTR style = 0;
  explicit WaitingProgress(HWND parent) {
    if (!parent) return;
    bar = GetDlgItem(FindWindowExW(parent, nullptr, L"#32770", nullptr), 1004);
    if (!bar) return;
    style = GetWindowLongPtrW(bar, GWL_STYLE);
    SetWindowLongPtrW(bar, GWL_STYLE, style | PBS_MARQUEE);
    SendMessageW(bar, PBM_SETMARQUEE, TRUE, 40);
  }
  ~WaitingProgress() {
    if (!bar || !IsWindow(bar)) return;
    SendMessageW(bar, PBM_SETMARQUEE, FALSE, 0);
    SetWindowLongPtrW(bar, GWL_STYLE, style);
    InvalidateRect(bar, nullptr, TRUE);
  }
};
static bool waitWithMessages(HANDLE process) {
  bool quit = false;
  int quitCode = 0;
  bool completed = false;
  for (;;) {
    const DWORD ready = MsgWaitForMultipleObjects(1, &process, FALSE, INFINITE, QS_ALLINPUT);
    if (ready == WAIT_OBJECT_0) { completed = true; break; }
    if (ready != WAIT_OBJECT_0 + 1) break;
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) { quit = true; quitCode = static_cast<int>(message.wParam); continue; }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }
  if (quit) PostQuitMessage(quitCode);
  return completed;
}
static std::wstring pop(Stack** stack) {
  if (!stack || !*stack) return {};
  Stack* item = *stack;
  std::wstring value(item->text);
  *stack = item->next;
  GlobalFree(item);
  return value;
}
static void push(Stack** stack, int capacity, const std::wstring& value) {
  Stack* item = static_cast<Stack*>(GlobalAlloc(GPTR, sizeof(Stack) + capacity * sizeof(wchar_t)));
  if (!item) return;
  lstrcpynW(item->text, value.c_str(), capacity);
  item->next = *stack;
  *stack = item;
}
static std::wstring finalPath(HANDLE handle) {
  const DWORD size = GetFinalPathNameByHandleW(handle, nullptr, 0, FILE_NAME_NORMALIZED);
  if (!size) return {};
  std::vector<wchar_t> buffer(size + 1);
  if (!GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED)) return {};
  std::wstring path(buffer.data());
  if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) path = L"\\\\" + path.substr(8);
  else if (path.rfind(L"\\\\?\\", 0) == 0) path = path.substr(4);
  return path;
}
static HANDLE openDirectory(const std::wstring& path, bool exclusive = false, bool writeAttributes = false) {
  return CreateFileW(path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL | (exclusive ? DELETE : 0) | (writeAttributes ? FILE_WRITE_ATTRIBUTES : 0),
    exclusive ? FILE_SHARE_READ : FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
}
static bool directoryInfo(HANDLE handle, BY_HANDLE_FILE_INFORMATION& info) {
  return GetFileInformationByHandle(handle, &info) && (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) &&
    !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT);
}
static bool markDeleted(HANDLE handle) {
  FILE_DISPOSITION_INFO disposition = { TRUE };
  return SetFileInformationByHandle(handle, FileDispositionInfo, &disposition, sizeof(disposition)) != FALSE;
}
// Only called after a successful child exit, with the unique root held against
// writes/rename. Open every descendant without following reparse points; delete
// by its handle, never by an unverified path or a shell recursive command.
static bool cleanupOwned(HANDLE directory, const std::wstring& path, unsigned depth = 0) {
  if (depth > 128) return false;
  WIN32_FIND_DATAW item{};
  HANDLE find = FindFirstFileW((path + L"\\*").c_str(), &item);
  if (find == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND && markDeleted(directory);
  bool ok = true;
  do {
    if (wcscmp(item.cFileName, L".") == 0 || wcscmp(item.cFileName, L"..") == 0) continue;
    const std::wstring childPath = path + L"\\" + item.cFileName;
    Handle child(CreateFileW(childPath.c_str(), DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES,
      FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    BY_HANDLE_FILE_INFORMATION info{};
    if (!child.valid() || !GetFileInformationByHandle(child.value, &info)) { ok = false; break; }
    if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      if (!cleanupOwned(child.value, childPath, depth + 1)) { ok = false; break; }
    } else {
      if (info.dwFileAttributes & FILE_ATTRIBUTE_READONLY) {
        FILE_BASIC_INFO basic{};
        if (!GetFileInformationByHandleEx(child.value, FileBasicInfo, &basic, sizeof(basic))) { ok = false; break; }
        basic.FileAttributes &= ~FILE_ATTRIBUTE_READONLY;
        if (!SetFileInformationByHandle(child.value, FileBasicInfo, &basic, sizeof(basic))) { ok = false; break; }
      }
      if (!markDeleted(child.value)) { ok = false; break; }
    }
  } while (FindNextFileW(find, &item));
  const DWORD last = GetLastError();
  FindClose(find);
  if (!ok || (last != ERROR_NO_MORE_FILES && last != ERROR_SUCCESS)) return false;
  return markDeleted(directory);
}
static std::vector<wchar_t> childEnvironment(const std::wstring& temp) {
  wchar_t* block = GetEnvironmentStringsW();
  if (!block) throw 1;
  std::vector<std::wstring> values;
  for (const wchar_t* entry = block; *entry; entry += wcslen(entry) + 1) {
    if (_wcsnicmp(entry, L"TEMP=", 5) != 0 && _wcsnicmp(entry, L"TMP=", 4) != 0) values.emplace_back(entry);
  }
  FreeEnvironmentStringsW(block);
  values.push_back(L"TEMP=" + temp);
  values.push_back(L"TMP=" + temp);
  std::sort(values.begin(), values.end(), [](const auto& a, const auto& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
  std::vector<wchar_t> result;
  for (const auto& value : values) { result.insert(result.end(), value.begin(), value.end()); result.push_back(0); }
  result.push_back(0);
  return result;
}
struct PrivateSecurity {
  std::vector<BYTE> user, system;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), nullptr, FALSE };
  PrivateSecurity() {
  HANDLE tokenRaw = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &tokenRaw)) return;
  Handle token(tokenRaw);
  DWORD size = 0;
  GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
  std::vector<BYTE> buffer(size);
  if (!GetTokenInformation(token.value, TokenUser, buffer.data(), size, &size)) return;
  PSID tokenSid = reinterpret_cast<TOKEN_USER*>(buffer.data())->User.Sid;
  user.resize(GetLengthSid(tokenSid));
  if (!CopySid(static_cast<DWORD>(user.size()), user.data(), tokenSid)) return;
  DWORD systemSize = SECURITY_MAX_SID_SIZE;
  system.resize(systemSize);
  if (!CreateWellKnownSid(WinLocalSystemSid, nullptr, system.data(), &systemSize)) return;
  wchar_t* sid = nullptr;
  if (!ConvertSidToStringSidW(user.data(), &sid)) return;
  std::wstring sddl = L"O:" + std::wstring(sid) + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)";
  LocalFree(sid);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr)) return;
  attributes.lpSecurityDescriptor = descriptor;
  }
  ~PrivateSecurity() { if (descriptor) LocalFree(descriptor); }
  bool valid() const { return descriptor != nullptr; }
  bool matches(HANDLE directory) const {
    PSID owner = nullptr;
    PACL acl = nullptr;
    PSECURITY_DESCRIPTOR actual = nullptr;
    if (!valid() || GetSecurityInfo(directory, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, nullptr, &acl, nullptr, &actual) != ERROR_SUCCESS) return false;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    bool ok = owner && EqualSid(owner, const_cast<BYTE*>(user.data())) && acl &&
      GetSecurityDescriptorControl(actual, &control, &revision) && (control & SE_DACL_PROTECTED);
    bool hasUser = false, hasSystem = false;
    for (DWORD index = 0; ok && index < acl->AceCount; ++index) {
      void* raw = nullptr;
      if (!GetAce(acl, index, &raw)) { ok = false; break; }
      const auto* ace = static_cast<ACCESS_ALLOWED_ACE*>(raw);
      if (ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags != (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) ||
          ace->Mask != FILE_ALL_ACCESS) { ok = false; break; }
      PSID who = const_cast<DWORD*>(&ace->SidStart);
      const bool isUser = EqualSid(who, const_cast<BYTE*>(user.data())) != FALSE;
      const bool isSystem = EqualSid(who, const_cast<BYTE*>(system.data())) != FALSE;
      if (!isUser && !isSystem) { ok = false; break; }
      hasUser = hasUser || isUser; hasSystem = hasSystem || isSystem;
    }
    LocalFree(actual);
    return ok && hasUser && hasSystem;
  }
};

// The persistent container is never recursively removed or repurposed. Existing
// untrusted ACLs/links are rejected, not silently repaired or followed.
static bool managedContainer(const std::wstring& parent, DWORD volume, PrivateSecurity& security,
  std::wstring& path, Handle& parentPin, Handle& containerPin) {
  Handle candidate(openDirectory(parent));
  BY_HANDLE_FILE_INFORMATION parentInfo{};
  if (!security.valid() || !candidate.valid() || !directoryInfo(candidate.value, parentInfo) ||
      parentInfo.dwVolumeSerialNumber != volume || _wcsicmp(finalPath(candidate.value).c_str(), parent.c_str()) != 0) return false;
  const std::wstring folder = parent + (parent.back() == L'\\' ? L"" : L"\\") + L".rufa";
  if (!CreateDirectoryW(folder.c_str(), &security.attributes) && GetLastError() != ERROR_ALREADY_EXISTS) return false;
  Handle container(openDirectory(folder, false, true));
  BY_HANDLE_FILE_INFORMATION info{};
  if (!container.valid() || !directoryInfo(container.value, info) || info.dwVolumeSerialNumber != volume ||
      _wcsicmp(finalPath(container.value).c_str(), folder.c_str()) != 0 || !security.matches(container.value)) return false;
  FILE_BASIC_INFO basic{};
  if (!GetFileInformationByHandleEx(container.value, FileBasicInfo, &basic, sizeof(basic))) return false;
  basic.FileAttributes |= FILE_ATTRIBUTE_HIDDEN;
  if (!SetFileInformationByHandle(container.value, FileBasicInfo, &basic, sizeof(basic))) return false;
  path = folder;
  parentPin.value = candidate.value; candidate.value = INVALID_HANDLE_VALUE;
  containerPin.value = container.value; container.value = INVALID_HANDLE_VALUE;
  return true;
}

static bool privateDirectory(const std::wstring& parent, PrivateSecurity& security, std::wstring& path) {
  if (!security.valid()) return false;
  bool created = false;
  for (int attempt = 0; attempt < 8; ++attempt) {
    GUID guid{};
    if (FAILED(CoCreateGuid(&guid))) break;
    // Encode all 128 random GUID bits without the long textual GUID decoration.
    constexpr wchar_t alphabet[] = L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::wstring name;
    unsigned bits = 0, count = 0;
    for (BYTE value : reinterpret_cast<const BYTE(&)[sizeof(GUID)]>(guid)) {
      bits = (bits << 8) | value;
      count += 8;
      while (count >= 6) { count -= 6; name += alphabet[(bits >> count) & 63]; }
    }
    if (count) name += alphabet[(bits << (6 - count)) & 63];
    const std::wstring candidate = parent + (parent.back() == L'\\' ? L"" : L"\\") + L".ru-" + name;
    // NSIS 3's temporary path APIs need room for their own nstXXXX.tmp suffix.
    if (candidate.size() >= MAX_PATH - 32) break;
    if (CreateDirectoryW(candidate.c_str(), &security.attributes)) { path = candidate; created = true; break; }
    if (GetLastError() != ERROR_ALREADY_EXISTS) break;
  }
  return created;
}

struct PathBudget { size_t file = 0, directory = 0; };
static std::wstring extendedPath(const std::wstring& path) {
  return path.rfind(L"\\\\", 0) == 0 ? L"\\\\?\\UNC\\" + path.substr(2) : L"\\\\?\\" + path;
}
static bool inventoryPaths(const std::wstring& root, const std::wstring& relative, PathBudget& budget, unsigned depth = 0) {
  if (depth > 128) return false;
  WIN32_FIND_DATAW item{};
  HANDLE find = FindFirstFileW((extendedPath(root + relative) + L"\\*").c_str(), &item);
  if (find == INVALID_HANDLE_VALUE) return GetLastError() == ERROR_FILE_NOT_FOUND;
  bool ok = true;
  do {
    if (!wcscmp(item.cFileName, L".") || !wcscmp(item.cFileName, L"..")) continue;
    const std::wstring child = relative + L"\\" + item.cFileName;
    // Unknown link trees retain the original uninstaller behavior instead of
    // inventing a path budget or traversing targets during this read-only scan.
    if (item.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { ok = false; break; }
    if (item.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
      if (child.size() > budget.directory) budget.directory = child.size();
      if (!inventoryPaths(root, child, budget, depth + 1)) { ok = false; break; }
    } else if (child.size() > budget.file) budget.file = child.size();
  } while (FindNextFileW(find, &item));
  const DWORD last = GetLastError();
  FindClose(find);
  return ok && (last == ERROR_NO_MORE_FILES || last == ERROR_SUCCESS);
}
static std::vector<std::wstring> candidateParents(const std::wstring& parent) {
  std::vector<std::wstring> result;
  std::wstring current = parent;
  for (;;) {
    result.push_back(current);
    const size_t separator = current.find_last_of(L'\\');
    if (separator == std::wstring::npos || separator == current.size() - 1) break;
    if (separator == 2 && current[1] == L':') current = current.substr(0, 3);
    else current = current.substr(0, separator);
  }
  std::reverse(result.begin(), result.end());
  return result;
}
static bool fitsLegacyPaths(const std::wstring& temp, const PathBudget& budget) {
  // Native NSIS adds \\nsXXXX.tmp (12 chars reserved) and \\old-install (12).
  // Keep file paths below MAX_PATH and directories below its legacy margin.
  const size_t prefix = temp.size() + 24;
  return prefix + budget.file < MAX_PATH && prefix + budget.directory < MAX_PATH - 12;
}

extern "C" __declspec(dllexport) void __cdecl ExecWait(HWND parentWindow, int capacity, wchar_t*, Stack** stack, void*) {
  WaitingProgress waiting(parentWindow);
  std::wstring installation = pop(stack);
  std::wstring command = pop(stack);
  std::wstring status = L"prepare-error", retained;
  DWORD exitCode = 2;
  try {
    Handle installed(openDirectory(installation));
    BY_HANDLE_FILE_INFORMATION targetInfo{};
    if (!installed.valid() || !directoryInfo(installed.value, targetInfo)) throw 1;
    const std::wstring canonical = finalPath(installed.value);
    const size_t separator = canonical.find_last_of(L'\\');
    if (canonical.empty() || separator == std::wstring::npos || separator == canonical.size() - 1 || command.empty()) throw 1;
    const std::wstring parent = canonical.substr(0, separator == 2 && canonical[1] == L':' ? 3 : separator);
    Handle parentHandle, containerHandle, temporary;
    PrivateSecurity security;
    PathBudget budget;
    const bool knownBudget = inventoryPaths(canonical, L"", budget);
    if (knownBudget) for (const auto& candidateParent : candidateParents(parent)) {
      // The compact random name is 26 characters; skip an impossible parent
      // before creating anything. All new transactions are inside one stable
      // hidden container, never scattered directly in the volume root.
      const std::wstring estimate = candidateParent + (candidateParent.back() == L'\\' ? L"" : L"\\") + L".rufa\\" + std::wstring(26, L'x');
      if (!fitsLegacyPaths(estimate, budget)) continue;
      Handle candidate, container;
      std::wstring containerPath;
      if (!managedContainer(candidateParent, targetInfo.dwVolumeSerialNumber, security, containerPath, candidate, container)) continue;
      if (!privateDirectory(containerPath, security, retained)) continue;
      temporary.value = openDirectory(retained, true);
      BY_HANDLE_FILE_INFORMATION tempInfo{};
      if (!temporary.valid() || !directoryInfo(temporary.value, tempInfo) || tempInfo.dwVolumeSerialNumber != targetInfo.dwVolumeSerialNumber ||
          _wcsicmp(finalPath(temporary.value).c_str(), retained.c_str()) != 0 || !security.matches(temporary.value) || !fitsLegacyPaths(retained, budget)) throw 1;
      parentHandle.value = candidate.value;
      candidate.value = INVALID_HANDLE_VALUE;
      containerHandle.value = container.value;
      container.value = INVALID_HANDLE_VALUE;
      break;
    }
    if (!temporary.valid()) {
      // Preserve the original installer's TEMP behavior when no compatible
      // short, protected same-volume directory is available. The caller runs
      // the exact native ExecWait path and labels this compatibility fallback.
      status = L"native-temp";
      exitCode = 0;
    } else {
    // Do not hold the installed directory: the native uninstaller must remove it.
    CloseHandle(installed.value);
    installed.value = INVALID_HANDLE_VALUE;
    auto environment = childEnvironment(retained);
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
      environment.data(), parent.c_str(), &startup, &process)) {
      status = L"launch-error";
      if (cleanupOwned(temporary.value, retained)) retained.clear();
    } else {
      Handle child(process.hProcess), thread(process.hThread);
      status = L"run-error";
      if (waitWithMessages(child.value) && GetExitCodeProcess(child.value, &exitCode)) {
        status = L"completed";
        if (exitCode == 0 && cleanupOwned(temporary.value, retained)) retained.clear();
        // Failed child: preserve everything left for recovery, even an empty root.
      }
    }
    }
  } catch (...) { /* Fail before continuing installation; keep any owned residue. */ }
  push(stack, capacity, retained);
  push(stack, capacity, std::to_wstring(exitCode));
  push(stack, capacity, status);
}
