package com.example.groupware.service;

import com.example.groupware.controller.UserCreateRequest;
import com.example.groupware.domain.User;
import com.example.groupware.repository.DepartmentRepository;
import com.example.groupware.repository.UserRepository;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class UserService {

    private final UserRepository userRepository;
    private final DepartmentRepository departmentRepository;

    public UserService(UserRepository userRepository, DepartmentRepository departmentRepository) {
        this.userRepository = userRepository;
        this.departmentRepository = departmentRepository;
    }

    public List<User> search(String keyword) {
        return userRepository.searchByName(keyword);
    }

    public User findUser(Long id) {
        // SRC-04: Optional 을 확인 없이 꺼낸다. 없는 id 면 NoSuchElementException 이 그대로 500 이 된다.
        return userRepository.findById(id).get();
    }

    public User createUser(UserCreateRequest request) {
        User user = new User();
        user.setLoginId(request.getLoginId());
        user.setName(request.getName());

        // SRC-06: 비밀번호를 인코딩 없이 그대로 저장한다.
        user.setPassword(request.getPassword());

        // SRC-07: departmentId 가 null 인 경우를 처리하지 않는다.
        //         부서를 고르지 않고 저장하면 여기서 터져 화면에는 500 만 보인다.
        user.setDepartmentId(departmentRepository.findById(request.getDepartmentId()).get().getId());

        try {
            return userRepository.save(user);
        } catch (Exception e) {
            // SRC-03: 예외를 삼킨다. 저장이 실패해도 아무도 모른다.
        }
        return user;
    }

    public void deleteUser(Long id) {
        userRepository.deleteById(id);
    }
}
