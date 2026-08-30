package com.example.groupware.controller;

import com.example.groupware.domain.User;
import com.example.groupware.service.UserService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    private final UserService userService;

    public UserController(UserService userService) {
        this.userService = userService;
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping
    public List<User> list(@RequestParam(required = false) String keyword) {
        return userService.search(keyword);
    }

    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/{id}")
    public User detail(@PathVariable Long id) {
        return userService.findUser(id);
    }

    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping
    public ResponseEntity<User> create(@RequestBody UserCreateRequest request) {
        return ResponseEntity.ok(userService.createUser(request));
    }

    // SRC-01: 형제 엔드포인트에는 모두 붙어 있는 권한 검사가 삭제에만 없다.
    //         관리자웹에서 가장 비싼 결함이고, 실행 QA 는 이것을 볼 수 없다.
    //         (삭제 버튼은 DANGEROUS 로 차단되는 것이 정답이기 때문이다)
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        userService.deleteUser(id);
        return ResponseEntity.noContent().build();
    }
}
