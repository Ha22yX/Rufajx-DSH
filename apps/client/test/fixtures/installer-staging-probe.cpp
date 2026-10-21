// Compiles against the actual helper in an isolated test directory.
#include "installer-upgrade-temp.cpp"
#include <iostream>
#include <stdexcept>

static void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}
static bool exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }
static void sentinel(const std::wstring& path) {
  Handle file(CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  require(file.valid(), "create sentinel");
  DWORD written = 0;
  require(WriteFile(file.value, "keep", 4, &written, nullptr) && written == 4, "write sentinel");
}
static std::wstring securityText(const std::wstring& path) {
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  require(GetNamedSecurityInfoW(const_cast<wchar_t*>(path.c_str()), SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, nullptr, &descriptor) == ERROR_SUCCESS, "read ACL");
  wchar_t* text = nullptr;
  const bool ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, SDDL_REVISION_1,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &text, nullptr) != FALSE;
  LocalFree(descriptor);
  require(ok, "serialize ACL");
  std::wstring result(text); LocalFree(text); return result;
}
static bool container(const std::wstring& parent, DWORD volume, PrivateSecurity& security) {
  std::wstring path; Handle parentPin, containerPin;
  return managedContainer(parent, volume, security, path, parentPin, containerPin);
}
int wmain(int argc, wchar_t** argv) {
  try {
    require(argc == 2, "fixture root argument");
    const std::wstring suppliedRoot = argv[1];
    Handle fixture(openDirectory(suppliedRoot)); BY_HANDLE_FILE_INFORMATION info{};
    require(fixture.valid() && directoryInfo(fixture.value, info), "fixture root");
    const std::wstring root = finalPath(fixture.value);
    require(!root.empty(), "canonical fixture root");
    const DWORD volume = info.dwVolumeSerialNumber;
    PrivateSecurity security; require(security.valid(), "private security");
    const auto path = [&](const wchar_t* name) { return root + L"\\" + name; };
    unsigned passed = 0;
    {
      std::wstring managed; Handle parentPin, containerPin;
      require(managedContainer(path(L"fresh"), volume, security, managed, parentPin, containerPin), "new container");
      require(managed == path(L"fresh\\.rufa") && security.matches(containerPin.value), "container identity and ACL");
      require((GetFileAttributesW(managed.c_str()) & FILE_ATTRIBUTE_HIDDEN) != 0, "hidden container");
      sentinel(managed + L"\\shared-sentinel.txt");
      require(!MoveFileExW(managed.c_str(), (managed + L"-moved").c_str(), 0), "container pinned against rename");
      require(container(path(L"fresh"), volume, security), "reuse trusted container");
      std::wstring owned;
      require(privateDirectory(managed, security, owned), "private transaction creation");
      {
        Handle transaction(openDirectory(owned, true));
        require(transaction.valid() && security.matches(transaction.value), "private transaction ACL");
        sentinel(owned + L"\\owned.txt");
        require(cleanupOwned(transaction.value, owned), "owned transaction cleanup");
      }
      require(!exists(owned) && exists(managed + L"\\shared-sentinel.txt"), "shared container survives cleanup");
      ++passed;
    }
    {
      const auto unsafe = path(L"broad\\.rufa");
      const auto before = securityText(unsafe); const DWORD attrs = GetFileAttributesW(unsafe.c_str());
      require(!container(path(L"broad"), volume, security), "inherited ACL rejected");
      require(securityText(unsafe) == before && GetFileAttributesW(unsafe.c_str()) == attrs && exists(unsafe + L"\\keep.txt"), "unsafe existing directory unchanged");
      ++passed;
    }
    {
      wchar_t* sid = nullptr; require(ConvertSidToStringSidW(security.user.data(), &sid) != FALSE, "SID");
      const std::wstring sddl = L"O:" + std::wstring(sid) + L"D:P(A;OICI;FA;;;" + sid + L")(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)";
      LocalFree(sid); PSECURITY_DESCRIPTOR descriptor = nullptr;
      require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != FALSE, "broad protected descriptor");
      SECURITY_ATTRIBUTES attributes{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
      const auto unsafe = path(L"extra-trustee\\.rufa");
      const bool created = CreateDirectoryW(unsafe.c_str(), &attributes) != FALSE; LocalFree(descriptor);
      require(created, "broad protected container creation");
      const auto before = securityText(unsafe);
      require(!container(path(L"extra-trustee"), volume, security), "extra trustee rejected");
      require(securityText(unsafe) == before, "extra trustee ACL not repaired");
      ++passed;
    }
    require(!container(path(L"container-link"), volume, security), "container junction rejected");
    require(exists(path(L"outside\\keep.txt")), "junction target preserved"); ++passed;
    require(!container(path(L"parent-link"), volume, security), "parent junction rejected");
    require(!exists(path(L"outside\\.rufa")), "parent junction target untouched"); ++passed;
    require(!container(path(L"wrong-volume"), volume ^ 1U, security), "wrong volume rejected");
    require(!exists(path(L"wrong-volume\\.rufa")), "wrong volume creates nothing"); ++passed;
    require(!container(path(L"canonical\\..\\canonical"), volume, security), "noncanonical parent rejected");
    require(!exists(path(L"canonical\\.rufa")), "noncanonical parent creates nothing"); ++passed;
    {
      const auto parents = candidateParents(L"D:\\Example\\Nested");
      require(parents.size() == 3 && parents.front() == L"D:\\" && parents.back() == L"D:\\Example\\Nested", "volume-root ancestor order");
      require(candidateParents(L"D:\\") == std::vector<std::wstring>{L"D:\\"}, "volume-root parent terminates"); ++passed;
    }
    {
      const std::wstring staging = L"D:\\.rufa\\" + std::wstring(26, L'x');
      require(fitsLegacyPaths(staging, PathBudget{193, 160}), "actual longest path fits");
      require(!fitsLegacyPaths(staging, PathBudget{218, 104}), "over-budget file rejected");
      require(!fitsLegacyPaths(staging, PathBudget{193, 200}), "over-budget directory rejected"); ++passed;
    }
    std::cout << "{\"ok\":true,\"cases\":" << passed << "}\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << "; Windows error " << GetLastError() << "\n"; return 1; }
}
