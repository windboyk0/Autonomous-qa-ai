package com.example.groupware.repository;

import com.example.groupware.domain.User;
import jakarta.persistence.EntityManager;
import jakarta.persistence.PersistenceContext;
import org.springframework.stereotype.Repository;

import java.util.List;

@Repository
public class UserRepositoryImpl implements UserRepositoryCustom {

    @PersistenceContext
    private EntityManager em;

    @Override
    public List<User> searchByName(String keyword) {
        // SRC-02: 사용자 입력을 문자열로 이어 붙여 쿼리를 만든다.
        String sql = "SELECT * FROM users WHERE name LIKE '%" + keyword + "%'";
        return em.createNativeQuery(sql, User.class).getResultList();
    }
}
